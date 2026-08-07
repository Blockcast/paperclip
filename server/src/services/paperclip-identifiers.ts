/**
 * Paperclip issue-identifier extraction from GitHub PR text.
 *
 * Centralized so the webhook receiver (forward capture) and the
 * issue↔PR linkage service (storage + backfill reconciler) share ONE
 * extractor. The operator hard-guard (2026-06-05) is that PR→issue
 * attribution keys on the `BLO-####` ref in branch/title/body — NEVER on
 * the PR author login — because agent merged-PRs span ≥2 GitHub identities
 * (kkroo, app/allyblockcast, app/blockcast-ci-packages) and an author filter
 * silently drops whole identity buckets (the BLO-9103 floor bug). Keeping the
 * extractor in one place means that guarantee can't drift between the two paths.
 *
 * Logic is verbatim from the original webhook implementation (BLO-3182).
 */

// Conservative pattern: 2-10 uppercase letters/digits, dash, 1-6 digits.
// Anchored against word boundaries so mid-word `xBLO-3182y` doesn't match,
// but `(BLO-3182)`, `BLO-3182:`, or `feat/BLO-3182-thing` all do.
// Compact lists such as `BLO-3763/3764` are expanded to both identifiers.
export const PAPERCLIP_IDENTIFIER_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6}(?:\/\d{1,6})*)\b/g;
export const PAPERCLIP_COMPACT_IDENTIFIER_PATTERN = /^([A-Z][A-Z0-9]{1,9})-(\d{1,6})((?:\/\d{1,6})*)$/;

export function expandPaperclipIdentifierToken(token: string): string[] {
  const match = token.match(PAPERCLIP_COMPACT_IDENTIFIER_PATTERN);
  if (!match) return [token];
  const prefix = match[1]!;
  const firstNumber = match[2]!;
  const tailNumbers = (match[3] ?? "").split("/").filter(Boolean);
  return [firstNumber, ...tailNumbers].map((number) => `${prefix}-${number}`);
}

export function extractPaperclipIdentifiers(...sources: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    const matches = source.matchAll(PAPERCLIP_IDENTIFIER_PATTERN);
    for (const match of matches) {
      if (match[1]) {
        for (const identifier of expandPaperclipIdentifierToken(match[1])) {
          found.add(identifier);
        }
      }
    }
  }
  return Array.from(found);
}

/** How an issue↔PR link was established. Author is deliberately NOT a source. */
export type PullRequestLinkSource = "branch_ref" | "title_ref" | "body_ref" | "reconciler" | "manual";

/**
 * Resolve which PR field carried a given target identifier, preferring the
 * branch (option (A): the branchTemplate injects the issue ref into the branch
 * name, so a branch match is the strongest, process-enforced signal), then
 * title, then body. Returns null if none of the fields carry it.
 *
 * The branch tier MUST use the same case-insensitive, segment-anchored
 * extractor that decides ownership (BLO-20886). Real branches are lowercase and
 * PAPERCLIP_IDENTIFIER_PATTERN is uppercase-only, so classifying the branch with
 * the broad extractor made a lowercase branch-only owner -- `cto/blo-20886-...`,
 * the shape branchTemplate actually produces -- resolve to nothing here even
 * though ownership had already accepted it. It then fell through to `body_ref`;
 * if the body also mentioned a related issue in the same company, both
 * candidates carried equal strength and insertion order decided which one a
 * merged PR was persisted against, so the authoritative branch owner could lose
 * to a bare `Related:` mention.
 */
export function resolveLinkSourceForIdentifier(
  identifier: string,
  fields: { branch?: string | null; title?: string | null; body?: string | null },
): PullRequestLinkSource | null {
  if (extractBranchIdentifiers(fields.branch).includes(identifier)) return "branch_ref";
  if (extractPaperclipIdentifiers(fields.title).includes(identifier)) return "title_ref";
  if (extractPaperclipIdentifiers(fields.body).includes(identifier)) return "body_ref";
  return null;
}

// BLO-20886: a PR body commonly carries BOTH an owning reference (`Refs:`,
// `Fixes:`, `Closes:`, `Resolves:`) and a `Related:` list of informational
// backlinks with no ownership relationship to the PR at all. Every one of
// those identifiers is an equally-weighted match under
// extractPaperclipIdentifiers — nothing there distinguishes "the issue this
// PR closes" from "an issue this PR happens to mention" — so a caller that
// picks one to treat as the PR's owner (e.g. to address an author-directed
// wake) must not just grab an arbitrary entry. Only a line that opens with
// one of GitHub's own closing keywords or this repo's `Refs:` convention
// counts as an ownership claim; a bare mention (including under `Related:`)
// never does. The colon is optional -- existing PR bodies in this repo use
// both "Closes: BLO-1" and the natural-language "Closes BLO-1 and BLO-2".
//
// A leading markdown list marker is also optional, and that is load-bearing
// rather than cosmetic: .github/PULL_REQUEST_TEMPLATE.md renders its
// "## Linked Issues or Issue Description" section as a bullet list, so the
// repo's own house style for an owning reference is `- Refs: BLO-1`, not a
// bare `Refs: BLO-1` line. PR #953 -- the live misroute this rule exists to
// fix -- writes exactly `- Refs: [BLO-19132](...)`. Without the marker the
// body tier silently matches nothing on the majority of real PR bodies and
// every such PR fails closed to `no_owning_reference`, dropping an author
// wake that should have been delivered to its owner. CommonMark permits up to
// three leading spaces before a normal line; four spaces or a tab is code and
// must not create ownership. Fenced code is excluded for the same reason.
const OWNING_REFERENCE_LABEL_PATTERN =
  /^ {0,3}(?:[-*+]|\d{1,3}[.)])?[ \t]*(?:fix(?:e[sd])?|clos(?:e[sd]?)|resolv(?:e[sd]?)|refs?)[ \t]*:?[ \t]+(.+)$/i;
// Fenced code is what makes an example body safe to write: `Refs: BLO-1` inside
// a code block DOCUMENTS the convention, it does not claim ownership. Two
// perfectly ordinary Markdown forms defeated a root-level-only fence scanner,
// and neither needs an adversarial author to appear:
//
//   - A fence nested in a list item (`- ```md`). The opening line starts with a
//     list marker, so it never registered as a fence, leaving the indented
//     `Refs:` line inside it visible to the label match. This repo's own issue
//     bodies use exactly that shape to quote an example PR body.
//   - A line inside an open fence that repeats the marker with an info string
//     (``` js). CommonMark says a CLOSING fence may carry only whitespace after
//     its marker run, so that line is content -- but a length-only comparison
//     read it as the close, reopening the rest of the block to ownership.
//
// Both paths let an issue named only in an example capture an author-directed
// "push a follow-up commit" wake, which is this ticket's defect reached through
// the parser instead of the tier order. So: a fence opener is recognized after
// an optional list marker, and a fence closes only on a same-or-longer marker
// run followed by nothing but whitespace. Anything ambiguous keeps the fence
// OPEN, which fails closed to "no owning reference" -- the safe direction,
// since the caller then drops the wake or sends it to the reviewer rather than
// guessing an owner.
const MARKDOWN_FENCE_PATTERN = /^ {0,3}(?:[-*+]|\d{1,3}[.)])?[ \t]*(`{3,}|~{3,})(.*)$/;
// A CLOSING fence is a strictly narrower grammar than an opening one, and
// reusing the opener here was a real leak: the opener tolerates a list marker
// (`- ```) because a fence nested in a list item is ordinary Markdown, but
// CommonMark gives a closing fence no such latitude -- it admits up to three
// leading spaces, the marker run, then nothing but whitespace. A line like
// `- ``` ` sitting inside an open fence is therefore CONTENT, and accepting it
// as the close reopened the remainder of the block to ownership matching,
// exposing a following `Refs:` example exactly the way an unfenced one would.
const MARKDOWN_FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const TRAILING_NON_OWNING_LABEL_PATTERN =
  /(?:[;,][ \t]*|[ \t]+)(?:related|supersedes?|see[ \t]+also)[ \t]*:/i;

/**
 * Leading indentation of `line` in CommonMark columns, where a tab advances to
 * the next 4-column tab stop rather than counting as one character.
 *
 * Four columns makes an indented code block, which is why this matters here:
 * a literal `    ` and a literal `\t` were both already treated as code, but
 * the mixed forms that expand to the same width -- ` \t`, `  \t`, `   \t` --
 * were not, so an ownership label inside an indented example stayed eligible
 * to claim the PR. Counting columns instead of matching two literal prefixes
 * closes the whole family at once. Stops early: nothing above the threshold
 * needs a precise width.
 */
function leadingIndentColumns(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
    if (columns >= 4) return columns;
  }
  return columns;
}

/**
 * Yield the lines of `body` that a human actually SEES rendered: fenced code,
 * HTML comments, and indented code blocks are removed.
 *
 * Shared by both label extractors below. That sharing is the point rather than
 * incidental tidiness -- the two extractors answer the same question ("does
 * this body visibly declare an owner?") and any filter present in one but not
 * the other is a hole in the weaker one. The house-reference tier originally
 * scanned the raw Markdown, so `Issue: BLO-1` inside a fenced example, an HTML
 * comment, or an indented block could route an author-directed
 * "push a follow-up commit" wake to an issue that no reader of the PR would
 * ever identify as its owner -- this module's founding defect, reached through
 * the tier that was added last.
 *
 * Ambiguity fails CLOSED: an unterminated fence or `<!--` swallows the rest of
 * the body, yielding no owner rather than a guess. The caller then drops the
 * wake or sends it to the reviewer, which is the safe direction.
 */
function* visibleMarkdownLines(body: string): Generator<string> {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let htmlComment = false;
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      // Fenced content is literal: no comment stripping, no label matching.
      const closer = line.match(MARKDOWN_FENCE_CLOSE_PATTERN)?.[1];
      if (closer && closer[0] === fence.marker && closer.length >= fence.length) fence = null;
      continue;
    }

    // Comment state is advanced before any early-out below, so a multi-line
    // comment that opens on a skipped line still hides its own body.
    const { visible, open } = stripHtmlComments(line, htmlComment);
    htmlComment = open;

    // Indentation is read from the raw line because that is what determines
    // CommonMark block structure, and checked before the fence so an indented
    // ``` is code rather than a fence opener.
    if (leadingIndentColumns(line) >= 4) continue;

    const fenceMatch = visible.match(MARKDOWN_FENCE_PATTERN);
    if (fenceMatch?.[1]) {
      fence = { marker: fenceMatch[1][0] as "`" | "~", length: fenceMatch[1].length };
      continue;
    }

    yield visible;
  }
}

/**
 * Remove HTML-comment spans from one line, carrying `inComment` across lines.
 *
 * An HTML comment renders as nothing, so a `Refs:` line hidden inside one
 * declares an owner that no human reading the PR can see -- recreating the
 * wrong-assignee wake this module exists to prevent, with no visible cause to
 * debug from. The opener and its `-->` routinely sit on different lines (the
 * repo's own PULL_REQUEST_TEMPLATE.md ships multi-line instructional comments
 * in every section), which is why the state has to survive the line loop.
 * An unterminated `<!--` swallows the remainder of the body: fail closed.
 */
function stripHtmlComments(line: string, inComment: boolean): { visible: string; open: boolean } {
  let visible = "";
  let open = inComment;
  let index = 0;
  while (index < line.length) {
    if (open) {
      const end = line.indexOf("-->", index);
      if (end === -1) return { visible, open: true };
      open = false;
      index = end + 3;
      continue;
    }
    const start = line.indexOf("<!--", index);
    if (start === -1) {
      visible += line.slice(index);
      break;
    }
    visible += line.slice(index, start);
    open = true;
    index = start + 4;
  }
  return { visible, open };
}

/** Identifiers that appear on a labeled owning-reference line in `body` (see above). */
export function extractOwningLabeledIdentifiers(body: string | null | undefined): string[] {
  if (!body) return [];
  const found = new Set<string>();
  for (const line of visibleMarkdownLines(body)) {
    const match = line.match(OWNING_REFERENCE_LABEL_PATTERN);
    const rest = match?.[1]?.split(TRAILING_NON_OWNING_LABEL_PATTERN, 1)[0];
    if (!rest) continue;
    for (const identifier of extractPaperclipIdentifiers(rest)) found.add(identifier);
  }
  return Array.from(found);
}

// BLO-21312: `github_pr_review_requested` -- the exact wake reason BLO-20886
// was filed over -- arrives via `issue_comment` (an `@ally review` mention),
// not `pull_request`, and an issue_comment payload carries no
// `pull_request.head.ref`: the branch tier below is structurally unavailable
// on this path, not merely unmeasured, so the "match case-insensitively"
// fix for the branch tier cannot reach it. Real PR bodies on this path
// (#931, #963, #976, #916) name their owner with one of this repo's own
// non-closing house labels instead of a GitHub closing keyword: `Issue:`,
// `Paperclip task:`, `Paperclip issue:`, `Paperclip QA task:`.
//
// These are weaker ownership claims than a closing keyword -- an author
// writing "Issue: filed a related bug, see BLO-1" is not asserting the PR
// closes BLO-1 the way "Fixes: BLO-1" does -- so this tier is ranked below
// BOTH the closing-keyword tier and the branch tier in
// resolveOwningPaperclipIdentifiers. On `pull_request` events, which do
// carry a branch, the already-measured branch tier still wins whenever it
// resolves; this tier only ever activates when title, closing keyword, AND
// branch are all empty -- on `issue_comment` events, where fields.branch is
// never populated, that reduces to "title and closing keyword are both
// empty", making this the issue_comment path's practical last resort.
//
// Unlike OWNING_REFERENCE_LABEL_PATTERN above, the colon here is MANDATORY,
// not optional. The closing keywords (`Fixes`/`Closes`/`Resolves`/`Refs`) are
// verbs that only ever start a labeled reference line, so "Closes BLO-1" is
// unambiguous natural language. `Issue` is an ordinary noun that also starts
// ordinary sentences -- "Issue filed a related bug, see BLO-1" and "Issue
// description for BLO-2" are real English, not an ownership label -- so an
// optional colon here would route a branchless wake off of prose that never
// claimed ownership. Requiring the colon keeps this tier fail-closed on
// prose while still matching every observed house-label shape, all of which
// use a colon.
// Matched per visible line (see visibleMarkdownLines), not against the raw
// body: a house label inside a fenced example, an HTML comment, or an indented
// code block declares nothing a reader can see, and must not claim ownership.
const HOUSE_REFERENCE_LABEL_PATTERN =
  /^[ \t]*(?:[-*+]|\d{1,3}[.)])?[ \t]*(?:paperclip[ \t]+qa[ \t]+task|paperclip[ \t]+task|paperclip[ \t]+issue|issue)[ \t]*:[ \t]+(.+)$/i;

// BLO-21312: a house-reference line can still carry a second, distinctly
// labeled reference later on the SAME line -- `Issue: BLO-1; Related:
// BLO-2` -- and a naive "extract every identifier in the captured remainder"
// would resolve both, waking the assignee of BLO-2 even though it is
// explicitly marked non-owning right there on the line. The captured
// remainder is truncated at the first such secondary label so only the house
// label's own direct reference value is ever treated as owning.
const TRAILING_LABEL_REFERENCE_PATTERN =
  /[;,|][ \t]*(?:fix(?:e[sd])?|clos(?:e[sd]?)|resolv(?:e[sd]?)|refs?|relate[ds]?|see[ \t]+also|paperclip[ \t]+qa[ \t]+task|paperclip[ \t]+task|paperclip[ \t]+issue|issue)[ \t]*:/i;

function stripTrailingLabelReference(text: string): string {
  const match = text.match(TRAILING_LABEL_REFERENCE_PATTERN);
  return match && typeof match.index === "number" ? text.slice(0, match.index) : text;
}

/** Identifiers that appear on a labeled house-reference line in `body` (see above). */
export function extractHouseReferenceLabeledIdentifiers(body: string | null | undefined): string[] {
  if (!body) return [];
  const found = new Set<string>();
  for (const line of visibleMarkdownLines(body)) {
    const rest = line.match(HOUSE_REFERENCE_LABEL_PATTERN)?.[1];
    if (!rest) continue;
    const directValue = stripTrailingLabelReference(rest);
    if (!directValue) continue;
    for (const identifier of extractPaperclipIdentifiers(directValue)) found.add(identifier);
  }
  return Array.from(found);
}

/**
 * Identifiers carried by a BRANCH name, matched case-insensitively but only at
 * a path-segment boundary (branch start, or immediately after a `/`).
 *
 * Case-insensitivity is what makes the branch tier work at all: real branches
 * are lowercase (`sre/blo-20886-...`) and PAPERCLIP_IDENTIFIER_PATTERN is
 * uppercase-only. But uppercasing a whole branch and running the general
 * pattern over it also MANUFACTURES identifiers out of ordinary branch words
 * that happen to be followed by a number -- measured over the 200 most
 * recently-updated PRs in this repo, that produced `UNDICI-7` from
 * `blo-21612-undici-7.29.0`, `URI-3` from `fast-uri-3.1.5`, `ADDRESS-10` from
 * `ip-address-10.3.1`, `PR-870`, `FOLD-977` and `EXPANSION-5`. A dependency
 * bump's version number is not an ownership claim, and treating one as an
 * owner hands an author-directed "push a follow-up commit" wake to whoever is
 * assigned the same-named issue -- the exact misroute this module exists to
 * prevent, arrived at from the branch tier instead of the body.
 *
 * Anchoring to a segment boundary discriminates cleanly because the ref is
 * placed there by branchTemplate: `sre/blo-20886-...`, `kkroo/blo-19132-...`,
 * `blo-21610-...`. Over those same 200 branches the anchored rule agrees with
 * the unanchored one on 192, and on the 8 where they differ it drops ONLY the
 * spurious identifier while keeping the real `BLO-` one -- 0 real refs lost,
 * 0 gained.
 */
export function extractBranchIdentifiers(branch: string | null | undefined): string[] {
  if (!branch) return [];
  const found = new Set<string>();
  for (const match of branch.matchAll(BRANCH_IDENTIFIER_PATTERN)) {
    const token = match[1];
    if (!token) continue;
    for (const identifier of expandPaperclipIdentifierToken(token.toUpperCase())) {
      found.add(identifier);
    }
  }
  return Array.from(found);
}

// The trailing `(?!\.\d)` rejects a VERSION CONTINUATION, and it is what makes
// the segment anchor above actually hold. The anchor alone only helps when the
// package name sits mid-segment (`blo-21612-undici-7.29.0`); it does nothing
// when the package name STARTS a segment, which is exactly the shape Dependabot
// emits: `dependabot/npm_and_yarn/undici-7.29.0` puts `undici` right after a
// `/`, so `undici-7` clears the anchor and `\b` is satisfied by the following
// `.`. Measured on the real branch shapes, that manufactured `UNDICI-7`,
// `NODE-20` (`dependabot/npm_and_yarn/types/node-20.11.5`) and `CHECKOUT-4`
// (`dependabot/github_actions/actions/checkout-4.2.0`).
//
// A dot followed by a digit is unambiguously the rest of a semver, never part
// of an issue ref -- conventional branches continue with `-` (`blo-20886-round5`)
// or end (`sre/blo-20886`), so neither loses its ref here.
const BRANCH_IDENTIFIER_PATTERN = /(?:^|\/)([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6}(?:\/\d{1,6})*)\b(?!\.\d)/g;

export interface OwningIdentifierResolution {
  // The PR's authoritative issue identifier(s) -- empty when none was found.
  owning: string[];
}

/**
 * Resolve the identifier(s) that OWN a PR, as opposed to ones the PR body
 * merely mentions. Priority, most authoritative first:
 *
 *   1. title ref
 *   2. body line(s) explicitly labeled Fixes:/Closes:/Resolves:/Refs:
 *   3. branch ref, case-insensitively -- LAST resort among the two
 *      process-signal tiers, see below.
 *   4. body line(s) explicitly labeled with a non-closing house reference
 *      (Issue:/Paperclip task:/Paperclip issue:/Paperclip QA task:) -- LAST
 *      resort overall, see below (BLO-21312).
 *
 * A bare mention anywhere else in the body -- including under a `Related:`
 * label -- is never owning. Only the first non-empty tier is consulted, and
 * EVERY identifier in that tier is owning: a PR legitimately closing two
 * issues ("Closes BLO-1 and BLO-2") owns both, so multiplicity within the
 * winning tier is not ambiguity, just multiple owners. Empty means no owning
 * reference was found at all -- the caller's cue to fall back to a
 * non-assignee target (e.g. the reviewer) or drop with a logged reason,
 * never to widen the search to a lower-priority tier or an unlabeled mention
 * (BLO-20886: doing so routed an author-directed "push a follow-up commit"
 * wake to the assignee of an unrelated issue named only under `Related:`).
 *
 * On the branch tier being LAST among title/keyword/branch and case-
 * insensitive, both of which are measured rather than assumed.
 * resolveLinkSourceForIdentifier above ranks the branch FIRST on the theory
 * that branchTemplate injects the ref, making it process-enforced. Two
 * things falsify that here:
 *
 *   - PAPERCLIP_IDENTIFIER_PATTERN is uppercase-only and real branches are
 *     lowercase (`sre/blo-20886-...`), so an uppercase branch tier is inert:
 *     across 175 PRs active in the trailing 7 days it fired for 1. That
 *     silence is what made 24 of those PRs resolve to no owner at all and
 *     fail closed, losing an author wake they should have received. Matching
 *     case-insensitively recovers 21 of the 24; the remaining 3 carry no ref
 *     in the branch either and correctly stay unresolved.
 *   - Branches get repurposed, so a branch ref goes stale while the title
 *     stays current. Over the same 175 PRs a case-insensitive branch tier
 *     agrees with the title/labeled-body answer 142 times and disagrees 8 --
 *     and in the disagreements the branch is the wrong one (#909's branch
 *     says `blo-20049` while both its title and its body name BLO-20467, the
 *     issue it actually fixes). Ranking a stale-prone signal above a curated
 *     one would reintroduce this ticket's own defect, misrouting an
 *     author-directed wake in ~5% of cases.
 *
 * So the branch is consulted only when nothing curated resolved, where its
 * choices are 21 recovered wakes against 0 overridden answers.
 *
 * The house-reference tier (BLO-21312) exists for `github_pr_review_requested`
 * wakes that arrive via `issue_comment` rather than `pull_request`: that
 * payload shape carries no `pull_request.head.ref`, so `fields.branch` is
 * never populated and tier 3 is structurally empty regardless of case-
 * insensitivity. Real PR bodies on that path (#931, #963, #976, #916) name
 * their owner with a non-closing house label instead of a GitHub closing
 * keyword. That is a weaker ownership claim than `Fixes:`/`Closes:` -- it has
 * not been measured the way the branch tier was -- so it is ranked below the
 * branch tier too: for `pull_request` events (which do carry a branch), the
 * measured branch tier still wins whenever it resolves, and this tier only
 * activates when title, closing keyword, AND branch are all empty.
 */
export function resolveOwningPaperclipIdentifiers(fields: {
  branch?: string | null;
  title?: string | null;
  body?: string | null;
}): OwningIdentifierResolution {
  const tiers = [
    extractPaperclipIdentifiers(fields.title),
    extractOwningLabeledIdentifiers(fields.body),
    // Matched case-insensitively but only at a path-segment boundary, so a
    // conventional lowercase branch (`sre/blo-20886-fix`) resolves while a
    // version number or stray word-plus-digit (`...-undici-7.29.0`) does not
    // manufacture a spurious owner. See extractBranchIdentifiers.
    extractBranchIdentifiers(fields.branch),
    extractHouseReferenceLabeledIdentifiers(fields.body),
  ];
  for (const tier of tiers) {
    if (tier.length > 0) return { owning: tier };
  }
  return { owning: [] };
}

/**
 * Artifact-evidence gate (BLO-4461).
 *
 * Pure evaluator: given an issue + its recent comments + work_products + a
 * label→required-shapes registry, returns a verdict on whether the agent
 * has attached the evidence shapes the issue's labels demand.
 *
 * Phase 1 (BLO-4824): caller logs + records the verdict, never throws.
 * Phase 2 (BLO-4828): caller throws on `verdict === "block"`. The evaluator
 * is identical in both phases — only the call-site behavior changes.
 *
 * Designed as a pure evaluator: no IO, no DB, no clock-side-effects beyond
 * what the caller passes in. Caller is responsible for fetching comments +
 * work_products.
 */

import type {
  EvidenceRegistry,
  EvidenceShape,
} from "./evidence-shapes.js";
import { DEFAULT_UNLABELED_REQUIRED } from "./evidence-shapes.js";

export interface EvidenceIssueLite {
  description?: string | null;
  labels: Array<{ name: string }>;
}

export interface EvidenceCommentLite {
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date | string;
}

export interface EvidenceWorkProductLite {
  kind: string;
  metadata?: Record<string, unknown> | null;
  result?: string | null;
}

export type EvidenceVerdict = "pass" | "warn" | "block";

export interface EvaluateEvidenceInput {
  issue: EvidenceIssueLite;
  comments: EvidenceCommentLite[];
  workProducts: EvidenceWorkProductLite[];
  registry: EvidenceRegistry;
  /** Number of most-recent agent comments to concatenate when scanning. Default 10. */
  recentCommentLimit?: number;
  /** Optional repositories whose PR URLs count as reviewable evidence. */
  allowedPrRepos?: readonly string[];
  /** Caller-derived history signal: a prior description had Done-when bullets, current does not. */
  doneWhenBulletsRemoved?: boolean;
}

export interface EvaluateEvidenceResult {
  verdict: EvidenceVerdict;
  /** Shapes that were required but not detected. Empty on `pass`. */
  missing: EvidenceShape[];
  /** Required shapes that were detected. */
  evidenceFound: EvidenceShape[];
  /** Required shapes that were detected. */
  requiredFound: EvidenceShape[];
  /** All shapes detected, including shapes not required for this issue. */
  allDetected: EvidenceShape[];
  /** Per-shape detection booleans, useful for UI debugging + tests. */
  shapeDetections: Record<EvidenceShape, boolean>;
  /** True when the issue's labels did not match any registry entry. */
  unlabeledFallback: boolean;
  /** Suspicious or degraded inputs that callers should log. */
  diagnostics: string[];
}

const DEFAULT_RECENT_COMMENT_LIMIT = 10;
function normalizeLabel(value: string): string {
  return value.trim().normalize("NFC").toLocaleLowerCase("en-US");
}

const ALL_SHAPES: readonly EvidenceShape[] = [
  "screenshot:1440x900",
  "screenshot:390x844",
  "checklist:done-when",
  "test-output",
  "kubectl-state",
  "probe-output",
  "url-probe",
  "pr-link",
  "landing-artifact",
  "ci-green",
  "e2e-script",
  "e2e-run",
  "migration-output",
] as const;

/**
 * Compute the required-shape set for an issue by unioning the registry
 * entries for each label name (case-insensitive). When no label matches,
 * falls back to `DEFAULT_UNLABELED_REQUIRED` and flags `unlabeledFallback`.
 */
export function resolveRequiredShapes(
  issue: EvidenceIssueLite,
  registry: EvidenceRegistry,
): { required: EvidenceShape[]; unlabeledFallback: boolean } {
  const lowerRegistry: EvidenceRegistry = {};
  for (const [key, entry] of Object.entries(registry)) {
    lowerRegistry[normalizeLabel(key)] = entry;
  }

  const union = new Set<EvidenceShape>();
  let matchedAnyLabel = false;
  for (const label of issue.labels) {
    const entry = lowerRegistry[normalizeLabel(label.name)];
    if (!entry) continue;
    matchedAnyLabel = true;
    for (const shape of entry.required) union.add(shape);
  }

  if (!matchedAnyLabel) {
    return { required: [...DEFAULT_UNLABELED_REQUIRED], unlabeledFallback: true };
  }
  return { required: Array.from(union), unlabeledFallback: false };
}

/**
 * Build the concatenated agent-comment body the detectors scan. Filters to
 * agent-authored comments only (operator-side comments do not "produce
 * evidence" — they're feedback). Caps at `recentCommentLimit` to bound the
 * scan window and to keep the detector regexes from quadratic-time
 * exploding on very long issues.
 */
function buildAgentEvidenceText(
  comments: EvidenceCommentLite[],
  recentCommentLimit: number,
): string {
  const agentComments = comments.filter((c) => c.authorAgentId !== null);
  agentComments.sort((a, b) => {
    // Defensive: `new Date(badString).getTime()` returns NaN, and a NaN
    // comparator return value silently produces an engine-dependent order in
    // V8's TimSort — which would let a single malformed timestamp push real
    // evidence outside the recent-comment window and false-block the gate.
    // Coerce NaN/Infinity to epoch 0 so bad timestamps sort to the bottom of
    // the window deterministically. Caller should validate inputs upstream;
    // this is the last-line defense.
    const aRaw = new Date(a.createdAt).getTime();
    const bRaw = new Date(b.createdAt).getTime();
    const aT = Number.isFinite(aRaw) ? aRaw : 0;
    const bT = Number.isFinite(bRaw) ? bRaw : 0;
    return bT - aT;
  });
  return agentComments
    .slice(0, recentCommentLimit)
    .map((c) => c.body)
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Per-shape detectors. Each returns true if the shape is "attached".
//
// Detection runs locally against the agent-comment text + work_products. No
// outbound HTTP, no parsing of remote content. The gate enforces the SHAPE
// of the receipt, not its truth — QA Engineer (BLO-4827) re-runs the
// receipt against the live artifact to catch fakery.
// ---------------------------------------------------------------------------

function detectScreenshotViewport(
  text: string,
  workProducts: EvidenceWorkProductLite[],
  viewport: string,
): boolean {
  const [w, h] = viewport.split("x");
  // 1. Work-product with explicit viewport metadata.
  for (const wp of workProducts) {
    if (wp.kind !== "screenshot") continue;
    const meta = wp.metadata;
    if (!meta) continue;
    const mv = (meta as { viewport?: unknown }).viewport;
    if (typeof mv === "string" && mv === viewport) return true;
  }
  // 2. Inline markdown image whose filename or alt mentions the viewport.
  const inlinePattern = new RegExp(
    `!\\[[^\\]]*\\]\\([^)]*${w}\\s*[x_-]?\\s*${h}[^)]*\\)`,
    "i",
  );
  if (inlinePattern.test(text)) return true;
  // 3. Filename/path reference near a screenshot / Playwright keyword.
  //    Matches "blog_listing_desktop_1440.png ... 1440x900" or similar.
  const looseFilename = new RegExp(
    `(?:\\b[\\w./-]+\\.(?:png|jpe?g|webp)\\b[\\s\\S]{0,200}\\b${w}\\s*[x_-]?\\s*${h}\\b|\\b${w}\\s*[x_-]?\\s*${h}\\b[\\s\\S]{0,200}\\b[\\w./-]+\\.(?:png|jpe?g|webp)\\b)`,
    "i",
  );
  return looseFilename.test(text);
}

function detectChecklistDoneWhen(
  text: string,
  issueDescription: string | null | undefined,
): boolean {
  if (!issueDescription) {
    // No description = no acceptance criteria to map against. The shape is
    // undetectable, and it stays REQUIRED: an issue with no criteria at all
    // should not reach in_review, so this reports `missing` and (unlabeled)
    // `warn` / (labeled) `block`. (Previously this returned a vacuous `true`,
    // which let unlabeled issues with no criteria reach a `pass` verdict with
    // zero artifacts.)
    //
    // NB: this comment used to claim `evaluateEvidence` drops the shape from
    // the required set when inapplicable. It does not, and never did — it only
    // adds a diagnostic. The false claim cost a debugging cycle in BLO-19047;
    // the remedy is to fix the description, not to weaken the requirement.
    return false;
  }
  const doneWhenBullets = countDoneWhenBullets(issueDescription);
  if (doneWhenBullets === 0) return false;

  // A "checklist" is either:
  //  (a) A markdown table with N >= doneWhenBullets rows that include an
  //      explicit completion marker in any cell.
  //  (b) A completed task-list with N >= doneWhenBullets `- [x]` lines.

  const statusMarker = /✅|✓|✔|❌|✗|\[[xX]\]/;

  // (b) Task list count.
  const taskListMatches = text.match(/^[-*]\s+\[[xX]\]/gm);
  if (taskListMatches && taskListMatches.length >= doneWhenBullets) return true;

  // (a) Markdown table — count rows that contain a status marker.
  let taggedRowCount = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.includes("|")) continue;
    if (/^\s*\|[-:|\s]+\|\s*$/.test(line)) continue; // header separator
    if (statusMarker.test(line)) taggedRowCount += 1;
  }
  return taggedRowCount >= doneWhenBullets;
}

/**
 * Headings that introduce a per-criterion acceptance list. `Done when` was
 * the only recognized spelling until BLO-19047, which made the shape
 * unsatisfiable for every issue written to the company issue-creation policy
 * (that policy mandates `## Acceptance criteria`).
 *
 * Matched case-insensitively at any heading depth including `#`. The trailing
 * `\b` keeps a prose line that merely starts with the same words from matching,
 * and `[ \t]*` (rather than `\s*`) keeps the gap from spanning a newline.
 */
const DONE_WHEN_HEADING_SOURCE =
  "^(#{1,6})[ \\t]*(?:Done when|Acceptance criteria|Success criteria|Exit criteria)\\b";

/** Any line terminator JS regex `^`/`$` recognize, including a bare CR. */
const LINE_BREAK_RE = /\r?\n|\r/;

/**
 * A candidate fence line: at most three leading spaces (four or more is an
 * indented code block, not a fence), the run of fence characters, then the
 * remainder of the line. Group 1 is the run, group 2 the remainder.
 */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * True when a candidate line opens a fence.
 *
 * The remainder is the info string. CommonMark forbids a backtick inside a
 * backtick fence's info string, which is what keeps an inline code span such
 * as ```` ```code``` is inline ```` from being read as an opener.
 */
function isOpeningFence(match: RegExpExecArray): boolean {
  return !(match[1][0] === "`" && match[2].includes("`"));
}

/**
 * True when a candidate line closes the currently-open fence.
 *
 * A closer must use the same fence character, be at least as long as the
 * opener, and carry NOTHING but trailing whitespace. Accepting a closer with
 * trailing text (the pre-BLO-19047 behaviour, which reused the opener pattern
 * for both roles) ended the block early, so the rest of a pasted template —
 * headings and placeholder bullets included — leaked out of the fence and fed
 * the criteria count.
 */
function isClosingFence(match: RegExpExecArray | null, fence: string): boolean {
  if (!match) return false;
  return (
    match[1][0] === fence[0] &&
    match[1].length >= fence.length &&
    match[2].trim() === ""
  );
}

/**
 * Blank out fenced-code-block CONTENT, preserving line structure.
 *
 * Without this, a heading inside a pasted template or example fence counts as
 * the issue's own criteria section. That is not hypothetical: the company
 * issue-creation policy ships a fenced `## Acceptance criteria` template, so a
 * description that quotes the template would have its criteria count taken from
 * the template's placeholder bullets. (BLO-19047)
 *
 * An unterminated fence runs to the end of the document, per CommonMark.
 */
function stripFencedCodeBlocks(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split(LINE_BREAK_RE)
    .map((line) => {
      const match = FENCE_LINE_RE.exec(line);
      if (fence !== null) {
        if (isClosingFence(match, fence)) fence = null;
        // Blank the closer too: it is part of the block, not content.
        return "";
      }
      if (match && isOpeningFence(match)) {
        fence = match[1];
        return "";
      }
      return line;
    })
    .join("\n");
}

/** A recognized criteria section and the span it occupies in the scrubbed text. */
type CriteriaSection = { start: number; end: number; body: string };

/**
 * Every recognized criteria section, in document order.
 *
 * A section runs to the next heading of the SAME depth or shallower, so
 * `### Functional` sub-groups under `## Acceptance criteria` stay inside the
 * section instead of truncating it.
 */
function doneWhenSections(description: string): CriteriaSection[] {
  const scrubbed = stripFencedCodeBlocks(description);
  const headingRe = new RegExp(DONE_WHEN_HEADING_SOURCE, "gim");
  const sections: CriteriaSection[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(scrubbed)) !== null) {
    const depth = match[1].length;
    const rest = scrubbed.slice(match.index);
    const headingLineEnd = rest.search(LINE_BREAK_RE);
    // A heading on the final line with nothing after it has an empty body.
    const bodyStart =
      headingLineEnd === -1 ? scrubbed.length : match.index + headingLineEnd + 1;
    const nextSiblingHeading = scrubbed
      .slice(bodyStart)
      .search(new RegExp(`^#{1,${depth}}[ \\t]`, "m"));
    const bodyEnd =
      nextSiblingHeading === -1 ? scrubbed.length : bodyStart + nextSiblingHeading;
    sections.push({ start: match.index, end: bodyEnd, body: scrubbed.slice(bodyStart, bodyEnd) });
    // Zero-length matches are impossible here (the pattern requires a `#`), but
    // guard anyway so a future edit cannot spin this loop forever.
    if (headingRe.lastIndex <= match.index) headingRe.lastIndex = match.index + 1;
  }
  return sections;
}

/**
 * Recognized sections that are not nested inside another recognized section.
 *
 * A deeper synonym heading under a shallower one (`### Success criteria` inside
 * `## Acceptance criteria`) describes the SAME criteria the outer section
 * already contains, so counting both would double it.
 */
function outermostDoneWhenSections(description: string): CriteriaSection[] {
  const sections = doneWhenSections(description);
  return sections.filter(
    (section, index) =>
      !sections.some(
        (other, otherIndex) =>
          otherIndex !== index && other.start < section.start && section.end <= other.end,
      ),
  );
}

/** True when the description carries a criteria heading the gate recognizes. */
export function hasDoneWhenHeading(description: string): boolean {
  return doneWhenSections(description).length > 0;
}

function doneWhenBulletKeys(body: string): string[] {
  return Array.from(
    body.matchAll(/^[-*]\s+(.*)$/gm),
    (match, index) => {
      const normalized = (match[1] ?? "").trim().replace(/\s+/g, " ").toLowerCase();
      return normalized ? `text:${normalized}` : `empty:${index}`;
    },
  );
}

export function countDoneWhenBullets(description: string): number {
  // SUM every top-level recognized section rather than taking the first one
  // that has bullets. Taking the first non-empty section under-counted a
  // description carrying more than one real criteria list, and the count was
  // not monotonic: prepending `## Acceptance criteria\n- placeholder` to an
  // existing multi-item `## Done when` dropped the required evidence-row count
  // to one without tripping the `doneWhenBulletsRemoved` tamper signal, so the
  // checklist passed while most criteria stayed unverified. Summing cannot
  // decrease when another non-empty synonym section is added. (BLO-19047)
  //
  // A section with no bullets contributes 0, which is what keeps a pointer
  // section ("## Acceptance criteria / See the Done when list below.") from
  // shadowing the real list — the original reason for the first-non-empty rule.
  //
  // Sibling synonym sections can repeat the same checklist under another name
  // (`## Acceptance criteria` followed by `## Success criteria`). Count each
  // normalized bullet text once so the synonym does not inflate the required
  // evidence-row count, while still counting genuinely distinct criteria across
  // multiple sections.
  let total = 0;
  const seen = new Set<string>();
  for (const { body } of outermostDoneWhenSections(description)) {
    for (const key of doneWhenBulletKeys(body)) {
      if (seen.has(key)) continue;
      seen.add(key);
      total += 1;
    }
  }
  return total;
}

function detectTestOutput(text: string): boolean {
  // vitest banner
  if (/Test Files\s+\d+\s+passed/i.test(text)) return true;
  // pytest banner
  if (/=+\s+\d+\s+passed\s+in\s+[\d.]+s\s+=+/i.test(text)) return true;
  if (/^\s*\d+\s+passed\s+in\s+[\d.]+s\s*$/im.test(text)) return true;
  // jest banner
  if (/Tests:\s+\d+\s+passed/i.test(text)) return true;
  // mocha / generic "N tests passing"
  if (/\b\d+\s+(?:tests?|specs?)\s+passing\b/i.test(text)) return true;
  return false;
}

function detectKubectlState(text: string): boolean {
  // Pod listing header.
  if (/^\s*NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE/m.test(text)) return true;
  // Service / generic listing header.
  if (/^\s*NAME\s+TYPE\s+CLUSTER-IP/m.test(text)) return true;
  // Rollout output.
  if (/```[^`]*\bdeployment\s+"[\w-]+"\s+successfully rolled out\b[^`]*```/i.test(text)) {
    return true;
  }
  return false;
}

function detectProbeOutput(text: string): boolean {
  // A curl/wget invocation paired with something that looks like a response
  // body or status line within a reasonable window. We don't try to be too
  // clever — the goal is to force the agent to paste *something* observable.
  const probeAndBody =
    /\b(?:curl|wget|http)\b[^\n]*\n[\s\S]{0,500}?(?:HTTP\/[\d.]+\s+\d{3}|^\{[\s\S]*?\}$|<\!?DOCTYPE|<html)/im;
  if (probeAndBody.test(text)) return true;
  // Healthz / status-endpoint output.
  if (
    /\b(?:curl|wget)\b|HTTP\/1\.1/i.test(text) &&
    /"(?:status|state|ok)"\s*:\s*(?:"ok"|"healthy"|true)/i.test(text)
  ) {
    return true;
  }
  return false;
}

function detectUrlProbe(text: string): boolean {
  return /\bcurl\b[^\n]+https?:\/\/[^\s]+/i.test(text);
}

function extractGithubPrRepos(text: string): string[] {
  return Array.from(text.matchAll(/https?:\/\/github\.com\/([\w-]+\/[\w.-]+)\/pull\/\d+/gi)).map(
    (match) => match[1]!,
  );
}

function extractGithubCommitRepos(text: string): string[] {
  // Full-length (7-40 hex char) SHAs only — short 4-6 char abbreviations are
  // too collision-prone to trust as a landing artifact on their own, and
  // GitHub's own commit URLs never truncate below 7.
  return Array.from(
    text.matchAll(/https?:\/\/github\.com\/([\w-]+\/[\w.-]+)\/commit\/[0-9a-f]{7,40}\b/gi),
  ).map((match) => match[1]!);
}

function matchesAllowedRepo(repos: string[], allowedRepos?: readonly string[]): boolean {
  if (repos.length === 0) return false;
  if (!allowedRepos) return true;
  const allowed = new Set(allowedRepos.map((repo) => repo.toLocaleLowerCase("en-US")));
  return repos.some((repo) => allowed.has(repo.toLocaleLowerCase("en-US")));
}

function detectPrLink(text: string, allowedRepos?: readonly string[]): boolean {
  return matchesAllowedRepo(extractGithubPrRepos(text), allowedRepos);
}

/**
 * Landing-artifact shape (BLO-17560): a GitHub PR link OR a GitHub commit
 * link in the target repo. Added after two fabricated "implementation
 * complete" claims (BLO-6393, BLO-6395) satisfied every other shape for
 * their label — screenshots/test banner + a fully-checked done-when
 * checklist — for code that was never committed. Neither a bare prose
 * mention of a filename nor a short/abbreviated SHA counts: only a full
 * GitHub PR or commit URL is accepted, because that's the one claim the
 * agent cannot fabricate without the artifact actually existing at that
 * URL (QA Engineer / the operator can click through and verify).
 */
function detectLandingArtifact(text: string, allowedRepos?: readonly string[]): boolean {
  if (matchesAllowedRepo(extractGithubPrRepos(text), allowedRepos)) return true;
  if (matchesAllowedRepo(extractGithubCommitRepos(text), allowedRepos)) return true;
  return false;
}

function detectCiGreen(text: string, allowedRepos?: readonly string[]): boolean {
  if (!detectPrLink(text, allowedRepos)) return false;
  if (/All checks have passed/i.test(text)) return true;
  if (/"mergeable_state"\s*:\s*"clean"/i.test(text)) return true;
  if (/\bCI\s+green\b/i.test(text)) return true;
  return false;
}

function detectE2eScript(
  text: string,
  workProducts: EvidenceWorkProductLite[],
): boolean {
  for (const wp of workProducts) {
    if (wp.kind === "e2e-script") return true;
  }
  // Inline detection: a fenced code block with Playwright/Cypress idioms.
  if (
    /\bawait\s+page\.(?:goto|click|fill|waitForSelector|waitForURL)\b/.test(text)
  ) {
    return true;
  }
  if (/\bcy\.(?:visit|get|click|contains)\b/.test(text)) return true;
  return false;
}

function detectMigrationOutput(text: string): boolean {
  const hasMigrationRunnerSignal =
    /Applied\s+\d+\s+migration/i.test(text) ||
    /No pending migrations/i.test(text) ||
    /\d+\s+migration(?:s)?\s+applied/i.test(text) ||
    /drizzle-kit[\s\S]{0,80}(?:push|migrate|generate)/i.test(text) ||
    /INFO\s+\[alembic\.runtime/i.test(text) ||
    /Flyway\s+(?:Community|Pro|Teams)\s+Edition/i.test(text) ||
    /Liquibase\s+Community/i.test(text);
  // EXPLAIN / EXPLAIN ANALYZE plan output.
  if (/\b(?:Seq|Index|Bitmap Heap|Hash|Merge|Nested Loop)\s+(?:Scan|Join)\b/i.test(text)) return true;
  if (/\bcost=[\d.]+\.\.[\d.]+\s+rows=\d+/i.test(text)) return true;
  // psql row-count line: "(N rows)" or "(1 row)". This must be paired
  // with runner output so an incidental SELECT result cannot satisfy the gate.
  if (hasMigrationRunnerSignal && /\(\d+\s+rows?\)/i.test(text)) return true;
  // Migration runner banners.
  if (hasMigrationRunnerSignal) return true;
  return false;
}

function detectE2eRun(
  workProducts: EvidenceWorkProductLite[],
  text: string,
): boolean {
  for (const wp of workProducts) {
    if (wp.kind === "e2e-run" && wp.result === "pass") return true;
  }
  // Inline: a "PASS" or "✓ all tests" line near an e2e-style runner banner.
  if (/Running\s+\d+\s+tests?\s+using\s+\d+\s+workers?/i.test(text)) {
    return /\bpassed\b/i.test(text);
  }
  return false;
}

/**
 * Run all detectors and return per-shape booleans plus the joined found set.
 */
function detectAll(input: {
  issueDescription: string | null | undefined;
  text: string;
  workProducts: EvidenceWorkProductLite[];
  allowedPrRepos?: readonly string[];
}): { detections: Record<EvidenceShape, boolean>; found: EvidenceShape[] } {
  const { issueDescription, text, workProducts, allowedPrRepos } = input;
  const detections: Record<EvidenceShape, boolean> = {
    "screenshot:1440x900": detectScreenshotViewport(text, workProducts, "1440x900"),
    "screenshot:390x844": detectScreenshotViewport(text, workProducts, "390x844"),
    "checklist:done-when": detectChecklistDoneWhen(text, issueDescription),
    "test-output": detectTestOutput(text),
    "kubectl-state": detectKubectlState(text),
    "probe-output": detectProbeOutput(text),
    "url-probe": detectUrlProbe(text),
    "pr-link": detectPrLink(text, allowedPrRepos),
    "landing-artifact": detectLandingArtifact(text, allowedPrRepos),
    "ci-green": detectCiGreen(text, allowedPrRepos),
    "e2e-script": detectE2eScript(text, workProducts),
    "e2e-run": detectE2eRun(workProducts, text),
    "migration-output": detectMigrationOutput(text),
  };
  const found = ALL_SHAPES.filter((s) => detections[s]);
  return { detections, found };
}

/**
 * Pure evaluator. See top-of-file for semantics.
 *
 * Verdict semantics:
 *   - `pass`  — every required shape was detected.
 *   - `warn`  — at least one required shape is missing, BUT the issue had
 *               no matching registry entry (unlabeled fallback). Caller
 *               typically records but doesn't block.
 *   - `block` — at least one required shape is missing AND the issue's
 *               labels matched a registry entry. Strong signal.
 */
export function evaluateEvidence(
  input: EvaluateEvidenceInput,
): EvaluateEvidenceResult {
  const limit = input.recentCommentLimit ?? DEFAULT_RECENT_COMMENT_LIMIT;
  const diagnostics: string[] = [];
  if (Object.keys(input.registry).length === 0) diagnostics.push("empty-registry");
  if (input.comments.some((comment) => !Number.isFinite(new Date(comment.createdAt).getTime()))) {
    diagnostics.push("invalid-comment-timestamp");
  }
  const text = buildAgentEvidenceText(input.comments, limit);
  const resolved = resolveRequiredShapes(input.issue, input.registry);
  const { unlabeledFallback } = resolved;
  const required = resolved.required;

  const doneWhenApplicable =
    !!input.issue.description && countDoneWhenBullets(input.issue.description) > 0;
  if (!doneWhenApplicable && required.includes("checklist:done-when")) {
    diagnostics.push(input.issue.description ? "missing-done-when-bullets" : "missing-description");
    // Name the remedy, but only when it is actually the remedy. `missing:
    // ["checklist:done-when"]` on its own reads as "attach more evidence", and
    // no comment can ever satisfy this shape — the fix is in the DESCRIPTION.
    // Emit this ONLY when no recognized heading exists, so we never tell an
    // agent to rename a heading that is already correct but whose bullets the
    // counter didn't find. (BLO-19047)
    if (input.issue.description && !hasDoneWhenHeading(input.issue.description)) {
      diagnostics.push("no-done-when-heading");
    }
  }
  const requiredDoneWhenBulletsRemoved =
    input.doneWhenBulletsRemoved && required.includes("checklist:done-when");
  if (requiredDoneWhenBulletsRemoved) {
    diagnostics.push("done-when-bullets-removed");
  }
  if (unlabeledFallback && input.issue.labels.length > 0) {
    diagnostics.push("unmatched-labels-used-fallback");
  }

  const { detections, found } = detectAll({
    issueDescription: input.issue.description,
    text,
    workProducts: input.workProducts,
    allowedPrRepos: input.allowedPrRepos,
  });

  const missing = required.filter((s) => !detections[s]);
  const requiredFound = required.filter((s) => detections[s]);
  let verdict: EvidenceVerdict;
  if (requiredDoneWhenBulletsRemoved) {
    verdict = "block";
  } else if (missing.length === 0) {
    verdict = "pass";
  } else if (unlabeledFallback) {
    verdict = "warn";
  } else {
    verdict = "block";
  }

  return {
    verdict,
    missing,
    evidenceFound: requiredFound,
    requiredFound,
    allDetected: found,
    shapeDetections: detections,
    unlabeledFallback,
    diagnostics,
  };
}

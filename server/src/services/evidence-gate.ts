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
  /**
   * Detections computed outside this pure evaluator — in practice the GitHub
   * truth probe (`evidence-truth.ts`). `true` ADDS a detection; `false` and
   * `undefined` are ignored on purpose. A probe that cannot reach GitHub must
   * never be able to subtract evidence the text detectors genuinely found,
   * because that turns an outage into a block on correct work.
   */
  externalDetections?: Partial<Record<EvidenceShape, boolean>>;
  /** True when the probe could not establish truth (GitHub error, deadline, cap). Suppresses escalation to block. */
  probeFailed?: boolean;
  /**
   * True when the probe found NO linked pull request. A third state, not a
   * flavour of `probeFailed` — the probe worked and the answer is "there is
   * nothing to review".
   *
   * Passed as a boolean rather than derived here from `workProducts`, and
   * rather than string-matched out of the probe's diagnostics. Deriving it
   * would duplicate `prRefsFromWorkProducts`' free-text (D5) and sourceTrust
   * rules in a second place; string-matching would rot the moment someone
   * rewords a diagnostic.
   */
  noLinkedPullRequest?: boolean;
  /**
   * Wired from loadConfig().evidenceGateUnlabeledTruthBlock. Default off.
   *
   * NAME IS NARROWER THAN THE BEHAVIOUR: the env var is
   * `PAPERCLIP_EVIDENCE_UNLABELED_BLOCK`, but the escalation applies to any
   * truth-only gap, labeled or unlabeled. Kept as-is rather than renamed — the
   * name is load-bearing in the Helm chart, the rollout runbook and the
   * measurement baseline, and a rename buys nothing behavioural.
   *
   * It governs `review:ally-clean` ONLY. See BLOCKABLE_TRUTH_SHAPES.
   */
  unlabeledTruthBlock?: boolean;
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
  "review:ally-clean",
  "deploy:landed",
] as const;

/**
 * The shapes no comment text can produce. They are set only through
 * `externalDetections`, from a probe that reads GitHub — so an agent cannot
 * satisfy them by writing about its own work. `unlabeledTruthBlock` only ever
 * escalates a gap that is *entirely* within this set.
 */
export const TRUTH_SHAPES: readonly EvidenceShape[] = ["review:ally-clean", "deploy:landed"];

/**
 * The subset of `TRUTH_SHAPES` the operator flag may make binding.
 *
 * `deploy:landed` is deliberately NOT here, and no flag value may add it. The
 * gate runs on exactly one transition — INTO `in_review` (doc/EVIDENCE_GATE.md
 * L3/L15) — and `deploy:landed` means merged. `in_review` is the state a PR
 * occupies BEFORE it merges, so the shape is unsatisfiable at the only moment
 * it would ever be evaluated. Making it binding does not raise the bar, it
 * makes the transition unreachable.
 *
 * `review:ally-clean` is a different kind of shape despite sitting next to it
 * in the registry: an OPEN PR can be at head with 0 Critical / 0 Important, so
 * it is satisfiable exactly when the gate fires. That asymmetry is the whole
 * reason this list exists rather than the flag simply reading `TRUTH_SHAPES`.
 *
 * A flag can defer an inconvenience; it cannot defer an impossibility. Gating
 * `deploy:landed` behind `unlabeledTruthBlock` would not make it safe — it
 * would schedule the deadlock for whoever flips the flag.
 */
export const BLOCKABLE_TRUTH_SHAPES: readonly EvidenceShape[] = ["review:ally-clean"];

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

/**
 * A markdown list item's leading marker: unordered (`-`/`*`) or ordered
 * (`1.`, `1)`). ONE source, consumed by both the criteria counter
 * (`doneWhenBulletKeys`) and the evidence task-list counter
 * (`detectChecklistDoneWhen`), because those two are the halves of a single
 * comparison — criteria count vs evidence count — and a marker the one side
 * reads but the other does not makes the shape unsatisfiable rather than
 * merely under-counted.
 *
 * That is not hypothetical: BLO-34810 widened the criteria side alone, which
 * left `1. [x]` evidence (valid GFM, renders as a checkbox) matching zero
 * task-list lines against a now-correct criteria count. Keep them sharing
 * this constant rather than restating the character class.
 *
 * `^` carries no indent allowance: a nested item is a sub-point of the item
 * above it, not an item of its own. `\s+` after the marker is what keeps
 * `1.2.3 is the pinned version` from reading as a list item.
 */
const LIST_MARKER_SOURCE = "^(?:[-*]|\\d+[.)])\\s+";

/*
 * BOTH constants below are module-scoped AND carry `g`, so each owns a single
 * mutable `lastIndex` shared by every call. That is safe here only because of
 * WHICH method consumes them, not because of anything visible at these
 * definitions:
 *
 *   - `String.prototype.match` sets `lastIndex` to 0 on entry when the regex
 *     is global (`RegExp.prototype[Symbol.match]`), so it cannot resume from a
 *     previous call's offset.
 *   - `String.prototype.matchAll` iterates a CLONE, so it never writes back to
 *     the original's `lastIndex` — but it SEEDS that clone from it, so it can
 *     still SUFFER an offset some other caller left behind. Measured: with
 *     `lastIndex = 6`, a two-match input yields one match, and the original
 *     stays at 6.
 *
 * `.test()` / `.exec()` have neither property: they advance `lastIndex` and
 * resume from it, so adding one against either constant would silently skip
 * matches. The cycle length is set by the match count, not fixed — an N-match
 * input returns N trues and then one false, repeating. Measured on `.test()`:
 * a one-match input gives `true, false, true, false`; a two-match input gives
 * `true, true, false, true, true`. So spot-checking a multi-match string shows
 * consecutive trues and reads as fine — the skipped call is the one after the
 * last match. That is the kind of bug that survives a green test suite.
 *
 * If you need `.test()`/`.exec()`, reach for a NON-GLOBAL regex. That is the
 * fix — not a fresh global one per call, which is wasteful and re-acquires
 * this hazard the moment anyone hoists it to module scope. `FENCE_LINE_RE`
 * below is the in-file pattern to copy: module-scoped, no `g`, consumed by
 * `.exec()`. For these markers that means `new RegExp(LIST_MARKER_SOURCE,
 * "m")` — note the flags: `m`, not `gm`.
 *
 * Dropping `g` from THESE TWO constants specifically is not available:
 * `matchAll` throws a TypeError without it, and `.match()` needs it to return
 * ALL matches rather than the first — `detectChecklistDoneWhen` counts that
 * array's length.
 */

/**
 * A completed task-list line — any list marker followed by `[x]`.
 * Global + module-scoped: consumed ONLY via `.match()`, which resets
 * `lastIndex`. See the note above before adding a `.test()`/`.exec()` caller.
 */
const TASK_LIST_DONE_RE = new RegExp(`${LIST_MARKER_SOURCE}\\[[xX]\\]`, "gm");

/**
 * A list item under a criteria heading; group 1 is the criterion text.
 * Global + module-scoped: consumed ONLY via `.matchAll()`, which iterates a
 * clone. See the note above before adding a `.test()`/`.exec()` caller.
 */
const LIST_ITEM_RE = new RegExp(`${LIST_MARKER_SOURCE}(.*)$`, "gm");

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
  //  (b) A completed task-list with N >= doneWhenBullets `[x]` lines, under
  //      any list marker the criteria side also counts.

  const statusMarker = /✅|✓|✔|❌|✗|\[[xX]\]/;

  // (b) Task list count.
  const taskListMatches = text.match(TASK_LIST_DONE_RE);
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

/**
 * One key per criterion line under a recognized heading. A criterion carries
 * an unordered marker (`-`/`*`) or an ordered one (`1.`, `1)`).
 *
 * Ordered items were unmatched until BLO-34810, which made a fully-specified
 * numbered acceptance-criteria list count as zero criteria — so
 * `detectChecklistDoneWhen` short-circuited false and the row carried a
 * permanent `missing: ["checklist:done-when"]` that no comment could clear.
 * The only workarounds were renumbering the criteria (breaking every
 * cross-thread "AC 3" citation) or duplicating them into a parallel bullet
 * list that then drifts from the original.
 *
 * `^` is deliberately not preceded by an indent allowance: a nested item is a
 * sub-point of the criterion above it, not a criterion of its own, and
 * counting it would inflate the required evidence-row count.
 *
 * The marker class is shared with the evidence task-list counter via
 * `LIST_MARKER_SOURCE` — see that constant for why the two must not drift.
 *
 * Keys are normalized bullet TEXT, so the caller's cross-section dedup is
 * blind to which marker was used — a criteria list cannot be double-counted
 * by restating it under a synonym heading with the other marker style.
 */
function doneWhenBulletKeys(body: string): string[] {
  return Array.from(
    body.matchAll(LIST_ITEM_RE),
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
    // Not derivable from text by design — see TRUTH_SHAPES. Set only by the
    // caller merging `externalDetections` after this returns.
    "review:ally-clean": false,
    "deploy:landed": false,
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

  // A truth shape is computed against a PR head. On the UNLABELED fallback with
  // no linked PR, there is no head and never will be, so no truth shape is
  // REQUIRED — the same demotion `deploy:landed` got for being unsatisfiable at
  // the moment it is evaluated (evidence-shapes.ts).
  //
  // Suppressing only the escalation (below) fixed the BLOCK hazard and left the
  // METRIC one: `missing` still carried the shape, so the verdict stayed a
  // permanent `warn`, and `reviewPassRate` (`agent-scorecards.ts`, where warn
  // and block are both not-pass) was depressed for work no agent behaviour
  // could change. Inverted, not degraded — same diagnosis as `deploy:landed`.
  //
  // Scoped to the unlabeled fallback ON PURPOSE, and the line is satisfiability,
  // not blast radius:
  //   - Unlabeled is the doc-only / refactor population (see
  //     DEFAULT_UNLABELED_REQUIRED). There is no code to open a PR for, so the
  //     shape is unsatisfiable FOREVER and must not be binding.
  //   - A LABELED code issue with no linked PR keeps the shape required. Its
  //     assignee CAN satisfy it — open a PR and let the webhook link it — so it
  //     is a real gap, and it stays a `warn` via `truth-gap-warn-only` with the
  //     escalation suppressed by `noLinkedPullRequest` below. Dropping it there
  //     would let `landing-artifact`-via-commit-link reach `pass` with no review
  //     at all, which is the hole the truth shapes exist to close.
  //
  // `probeFailed` deliberately gets NO drop: a probe that could not reach GitHub
  // has not established that there is no PR. The shape stays required and only
  // the escalation is suppressed, so an outage can never launder a gap into a
  // `pass`.
  //
  // Can only move a verdict warn -> pass; it shrinks `required` and never grows
  // it. A mixed gap is untouched.
  const prLessUnlabeledTruthDrop =
    unlabeledFallback &&
    input.noLinkedPullRequest === true &&
    resolved.required.some((s) => TRUTH_SHAPES.includes(s));
  const required = prLessUnlabeledTruthDrop
    ? resolved.required.filter((s) => !TRUTH_SHAPES.includes(s))
    : resolved.required;
  if (prLessUnlabeledTruthDrop) {
    diagnostics.push("truth-shapes-not-required:no-linked-pull-request");
  }

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

  const { detections } = detectAll({
    issueDescription: input.issue.description,
    text,
    workProducts: input.workProducts,
    allowedPrRepos: input.allowedPrRepos,
  });

  // Additive only. See `externalDetections` on the input type for why a `false`
  // is ignored rather than clearing the text detector's finding.
  for (const [shape, hit] of Object.entries(input.externalDetections ?? {})) {
    if (hit === true && shape in detections) detections[shape as EvidenceShape] = true;
  }
  const foundAll = ALL_SHAPES.filter((s) => detections[s]);

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

  // The unlabeled fallback warns rather than blocks so the gate is not a chore
  // for refactor/doc issues.
  //
  // A gap made ENTIRELY of truth shapes is treated the same way, and
  // deliberately so on LABELED issues too. `deploy:landed` means merged, and
  // `in_review` is the state where work waits FOR review — so requiring it to
  // ENTER in_review would deadlock the normal flow for every code-completion
  // label (the gate throws 422 on a block at that transition). It is the same
  // reasoning that excludes the `pr` label in evidence-shapes.ts: an open PR
  // awaiting a decision cannot also be a merged one.
  //
  // So the shapes are recorded and measurable from day one, and only the
  // operator flag makes them binding — which is the measurement-first posture
  // the rollout runbook depends on. Without this, the risky half of the change
  // would ship ungated while the safe half shipped behind a flag.
  //
  // A MIXED gap is untouched: a labeled issue missing its screenshots still
  // blocks on the screenshots, exactly as before.
  const truthOnlyGap = missing.length > 0 && missing.every((s) => TRUTH_SHAPES.includes(s));
  if (verdict === "block" && truthOnlyGap) {
    verdict = "warn";
    diagnostics.push("truth-gap-warn-only");
  }

  // A failed probe suppresses the escalation outright. "The probe could not
  // reach GitHub" and "GitHub says this was never reviewed" are the same
  // `missing` list, and blocking on the first would make every GitHub outage
  // an estate-wide in_review freeze.
  //
  // So does a PR-less issue, for a stronger reason (CTO ruling 2026-09-16).
  // `review:ally-clean` needs a head to review; with no linked PR there is no
  // head, so the shape is unsatisfiable by the assignee FOREVER — not merely
  // at this transition, as with `deploy:landed`. An AC an assignee cannot
  // satisfy is a stall amplifier, not a gate. If we ever want "code work must
  // have a PR", that is an explicit requirement on a labeled path — not a side
  // effect of an absent probe result.
  //
  // The population reaching this arm is now LABELED-only: on the unlabeled
  // fallback the shape is dropped from `required` outright (see
  // `prLessUnlabeledTruthDrop` above), so its gap is empty and `truthOnlyGap` is
  // false before we get here. Both defenses are live and neither is dead code —
  // they cover disjoint populations, and the split is satisfiability: the
  // labeled assignee can open a PR, the doc-only one cannot.
  //
  // The gap must also contain a shape the flag is ALLOWED to bind — see
  // BLOCKABLE_TRUTH_SHAPES. A gap of only `deploy:landed` stays a warn at every
  // flag setting: it is informational by construction, feeding the scorecards
  // and the rollout measurement without ever gating the transition.
  //
  // Since `deploy:landed` is required NOWHERE in DEFAULT_EVIDENCE_REGISTRY or
  // DEFAULT_UNLABELED_REQUIRED, it can never enter `missing` on a shipped path,
  // so `blockableGap` is vacuously true there — belt-and-braces, not dead. It is
  // still reachable through a custom `registry` that requires the shape, and one
  // test drives exactly that: it is what pins the flag's scope to
  // BLOCKABLE_TRUTH_SHAPES independently of the registry decision, so the two
  // can never silently collapse into one.
  const blockableGap = missing.some((s) => BLOCKABLE_TRUTH_SHAPES.includes(s));
  if (verdict === "warn" && input.unlabeledTruthBlock === true && truthOnlyGap && blockableGap) {
    // Distinct reasons stay distinct in the verdict: the runbook's seven-day
    // measurement reads these apart to separate a GitHub outage from work that
    // can never satisfy the shape.
    const suppress =
      input.probeFailed === true
        ? "probe-failed"
        : input.noLinkedPullRequest === true
          ? "no-linked-pull-request"
          : null;
    if (suppress !== null) {
      diagnostics.push(`unlabeled-truth-block-suppressed:${suppress}`);
    } else {
      verdict = "block";
      diagnostics.push("unlabeled-truth-block");
    }
  }

  return {
    verdict,
    missing,
    evidenceFound: requiredFound,
    requiredFound,
    allDetected: foundAll,
    shapeDetections: detections,
    unlabeledFallback,
    diagnostics,
  };
}

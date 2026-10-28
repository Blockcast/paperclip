const BOUNDARY_SEARCH_WINDOW = 48;

/**
 * Cut `trimmed` down to at most `headLength` characters without splitting a word.
 *
 * Falls back to the hard cut when the only boundary is further back than
 * `BOUNDARY_SEARCH_WINDOW`, so a single very long token still truncates. The result is never
 * longer than `headLength`, which is what keeps every caller's cap intact.
 */
function cutHeadAtBoundary(trimmed: string, headLength: number) {
  if (headLength <= 0) return "";
  const head = trimmed.slice(0, headLength);
  if (headLength >= trimmed.length) return head.trimEnd();
  if (/\s/.test(trimmed.charAt(headLength))) return head.trimEnd();
  const boundary = head.search(/\s+\S*$/);
  if (boundary > 0 && head.length - boundary <= BOUNDARY_SEARCH_WINDOW) {
    return head.slice(0, boundary).trimEnd();
  }
  return head.trimEnd();
}

/** Mirror of `cutHeadAtBoundary` for the tail: start the kept span on a word boundary. */
function cutTailAtBoundary(trimmed: string, tailLength: number) {
  if (tailLength <= 0) return "";
  const tail = trimmed.slice(-tailLength);
  if (tailLength >= trimmed.length) return tail.trimStart();
  if (/\s/.test(trimmed.charAt(trimmed.length - tailLength - 1))) return tail.trimStart();
  const boundary = tail.slice(0, BOUNDARY_SEARCH_WINDOW).search(/\s/);
  if (boundary >= 0 && boundary < tail.length - 1) {
    return tail.slice(boundary).trimStart();
  }
  return tail.trimStart();
}

/**
 * Keep a head and a tail around an elision marker.
 *
 * The head/tail shape exists so a diagnosis that lives at the END of a long error string
 * survives the cap (BLO-31142) — head truncation was hiding the cause behind a long workspace
 * path. It is the right shape for single-line error strings.
 *
 * It is the wrong shape for prose: on a multi-paragraph section it deletes the middle and
 * leaves text that reads as continuous, so a reader cannot tell a span is missing (PEN-4311).
 * Use `truncateSectionText` there, and pass an explicit `marker` anywhere the default bare
 * `...` could be mistaken for an author's own ellipsis.
 */
// PEN-3107 CONTROL (probe branch only): a comment-only, type-clean touch under
// server/**, so the paths filter fires and the lane runs on a healthy tree.
export function truncateText(value: string, maxChars: number, marker = "...", separator = "") {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const available = Math.max(0, maxChars - marker.length - separator.length * 2);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  const head = cutHeadAtBoundary(trimmed, headLength);
  const tail = cutTailAtBoundary(trimmed, tailLength);
  return `${head}${separator}${marker}${separator}${tail}`;
}

function sectionElisionNotice(elidedChars: number, sourceLabel: string) {
  return `\n\n[... ${elidedChars.toLocaleString("en-US")} characters elided; read ${sourceLabel} for the full text ...]`;
}

/**
 * Shorten a prose section by dropping its TAIL and saying so.
 *
 * Three properties the bare-`...` middle elision did not have (PEN-4311):
 * the cut is marked and counted, it lands on a word boundary, and everything removed is at one
 * end — a reader is never handed two unrelated spans welded together by three dots.
 */
export function truncateSectionText(value: string, maxChars: number, sourceLabel = "the issue description") {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;

  // Reserve the widest notice this value could need, so the final string still fits `maxChars`:
  // the real elided count is never larger than the whole value.
  const reserved = sectionElisionNotice(trimmed.length, sourceLabel).length;
  const head = cutHeadAtBoundary(trimmed, Math.max(0, maxChars - reserved));
  return `${head}${sectionElisionNotice(trimmed.length - head.length, sourceLabel)}`;
}

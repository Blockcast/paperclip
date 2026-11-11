/**
 * PEN-6218 — carry operator/agent notes across the body re-render.
 *
 * Every firing, join, rebind and resolve path in this plugin publishes a body
 * rendered from alert state, as a WHOLESALE `description` PATCH. That is the
 * intended semantics — the top of an alert row is a projection of the alert,
 * and a stale projection is what BLO-41538 got closed on — but the patch is
 * whole-field, so anything a human or an agent had written into the same
 * column was discarded. Measured on PEN-4835: 69 description rewrites on one
 * row, and an agent's append survived 11 minutes of a 65-minute cycle. The
 * write returns 200 and a same-run read-back verifies byte-exact, so the loss
 * is invisible from the writing side.
 *
 * The fix is a split point. Everything above {@link AGENT_NOTES_MARKER} is
 * ours and is re-rendered on every sync; everything below it is carried
 * forward verbatim, forever, by whichever path writes next. The banner just
 * above the marker says so in the row itself, because the writing run never
 * reads this file — it reads the field it is about to overwrite.
 */

import { MACHINE_RENDERED_NOTICE } from "./issue-mapping.js";

/**
 * The split point. An HTML comment so it does not render, plugin-namespaced so
 * an alert annotation cannot collide with it by accident.
 *
 * ⚠ Never change this string. It is the only thing that distinguishes a body
 * this plugin may overwrite from notes it must keep, and it is already sitting
 * in rows written by earlier deliveries — a rename orphans every one of them
 * and their notes are lost on the next sync, which is the defect this exists
 * to remove.
 */
export const AGENT_NOTES_MARKER = "<!-- paperclip-plugin-alertmanager:notes-below -->";

/**
 * Rendered immediately ABOVE the marker, so it is part of the re-rendered half
 * and a wording change reaches every live row on its next sync.
 */
const NOTES_BANNER = [
  "---",
  "",
  "⚠️ Everything **above** this line is re-rendered by `paperclip-plugin-alertmanager`",
  "on every alert sync (about hourly while the alert is firing) and any edit made there",
  "is overwritten with no notice and no comment. Notes written **below** the line are",
  "preserved across syncs — put durable state there, or in a comment.",
].join("\n");

/**
 * The notes half of an existing body: everything after the marker, verbatim.
 *
 * Returns `"\n"` — not `""` — when there is nothing to keep, so the preserved
 * region always begins on its own line and the first person to append does not
 * end up writing on the same line as an HTML comment.
 *
 * ⚠ That is the WHOLE of the reason, and the first draft of this comment
 * claimed more: that the newline is what makes `composeDescription` a fixed
 * point. Measured — `""` is a fixed point too, and reverting to it turns
 * exactly one assertion red. Keep the newline for the formatting; do not cite
 * idempotency for it.
 */
export function preservedNotes(
  rendered: string,
  current: string | null | undefined,
): string {
  if (!current) return "\n";

  const at = current.indexOf(AGENT_NOTES_MARKER);
  if (at !== -1) {
    // FIRST occurrence, deliberately. A later copy of the marker can only come
    // from someone quoting it inside their own notes; splitting on the last
    // one would then drop everything they wrote above their copy. Splitting on
    // the first keeps every byte they wrote and costs at most a duplicated
    // marker inside the preserved half.
    const tail = current.slice(at + AGENT_NOTES_MARKER.length);
    return tail.trim() === "" ? "\n" : tail;
  }

  // No marker: either a row written before PEN-6218 shipped, or one whose
  // notes half was deleted by hand. We cannot tell an old render from appended
  // notes in general — but we can when the append was made on top of a body
  // this render reproduces, which is the shape measured on PEN-4835 (an
  // append-only agent write onto a body the plugin had re-sent byte-identical
  // 69 times). Anything else falls through to "no notes", i.e. exactly the
  // pre-PEN-6218 behaviour: this can lose nothing that was not already lost.
  const head = trimTrailingSpace(rendered);
  for (const candidate of legacyRenderHeads(head)) {
    if (!current.startsWith(candidate)) continue;
    const remainder = current.slice(candidate.length);
    // ...unless the render SHRANK. A prefix match says only that the stored
    // body begins with this render, and a smaller render of the same alert is
    // a prefix of a bigger one — our sections are appended in a fixed order
    // and joined with blank lines, so dropping a trailing one leaves exactly
    // this shape. The live case: a two-member aggregate loses a member, and
    // `buildAggregateIssueDescription` returns the representative alone
    // (`members.length < 2`), so the old `### Active members (2)` table — which
    // still lists the alert that just cleared, and still says "Falsify every
    // fingerprint here before closing" — reads as notes and is then carried
    // forward verbatim FOREVER. That is the stale-body wrong-close mechanism
    // of BLO-41538/BLO-42850, arriving through the fix for a different defect.
    //
    // So the rescue is refused whenever the remainder looks like something we
    // rendered. It errs toward refusing: a genuine note that quotes one of our
    // headings is dropped, which costs a one-time fall back to pre-PEN-6218
    // behaviour on legacy rows only, because after the first sync the row
    // carries the marker and this branch is never reached again. The opposite
    // error is permanent and asserts a cleared alert is still firing.
    if (remainder.trim() !== "" && !looksSelfRendered(remainder)) return remainder;
  }
  return "\n";
}

/**
 * PEN-6404 — the prefix rescue above matches a stored body against THIS render,
 * so every change to the render silently retires it for rows that have not yet
 * synced. Prepending {@link MACHINE_RENDERED_NOTICE} is such a change: a body
 * written before the notice existed cannot begin with a render that now leads
 * with it, so the single-candidate match could never fire again on a legacy row
 * and the rescue became dead code the moment the notice shipped.
 *
 * Measured 2026-11-11, the day PEN-6218 deployed: of 107 alertmanager-owned
 * rows, 17 carried the marker and **90 did not** (71 cancelled, 16 done, 3
 * todo). The legacy population is the rescue's whole reason to exist and it was
 * still the large majority, so this is a live regression rather than a
 * theoretical one.
 *
 * So try the render as it is, then the render as a pre-notice version of this
 * plugin would have emitted it. Order matters: the exact match is tried first,
 * so a row that DOES begin with the current render keeps the longer, more
 * specific prefix and the shorter one never shortens a remainder that the exact
 * match already explained.
 *
 * ⚠ This buys back exactly one renderer change — the notice. It is not a
 * general solution, and there is none: any edit to a rendered section moves the
 * prefix. What makes it worth doing is that the notice is the change shipping
 * alongside it, in the same release, against a population that is 84% legacy.
 */
function legacyRenderHeads(head: string): readonly string[] {
  const withoutNotice = MACHINE_RENDERED_NOTICE + "\n\n";
  return head.startsWith(withoutNotice)
    ? [head, trimTrailingSpace(head.slice(withoutNotice.length))]
    : [head];
}

/**
 * Every section start this plugin's own renderers emit (`buildIssueDescription`
 * and `buildAggregateIssueDescription` in `issue-mapping.ts`). A shrinking
 * render can only drop whole trailing sections, so one of these begins the
 * dropped tail in every case but the one handled below.
 *
 * ⚠ Keep in step with those renderers. A section added there and not listed
 * here is not a crash — it is a silent return to the behaviour above.
 */
const SELF_RENDERED_SECTIONS: readonly RegExp[] = [
  /^### Active members \(/m,
  /^### Labels\s*$/m,
  /^### Drill in\s*$/m,
  /^\*\*Summary\*\*:/m,
  /^\*\*Started\*\*:/m,
  /^\*\*Latest firing\*\*:/m,
  /^\*\*Severity\*\*:/m,
  /^\*\*Source\*\*:/m,
  /^\*\*Runbook\*\*:/m,
];

/** Could this text have come off one of our own renderers rather than a person? */
function looksSelfRendered(candidate: string): boolean {
  if (SELF_RENDERED_SECTIONS.some((pattern) => pattern.test(candidate))) return true;

  // The one shrink that drops no section header: the labels table losing its
  // last row (keys are rendered sorted, so the last one leaves a prefix). The
  // tail is then a bare `| key | value |` line. Tested on the FIRST non-empty
  // line only — notes that merely contain a table further down are still
  // rescued, since a person's append opens with prose or a heading.
  const firstLine = candidate.split("\n").find((line) => line.trim() !== "");
  return firstLine !== undefined && firstLine.trimStart().startsWith("|");
}

/**
 * The body to publish onto an existing row: this render, the banner, the
 * marker, then whatever notes the row already carried.
 *
 * Idempotent — `compose(r, compose(r, x)) === compose(r, x)` — so an unchanged
 * alert re-rendered onto its own row writes the same bytes rather than
 * accumulating banners.
 */
export function composeDescription(
  rendered: string,
  current: string | null | undefined,
): string {
  const head = trimTrailingSpace(rendered);
  return `${head}\n\n${NOTES_BANNER}\n${AGENT_NOTES_MARKER}${preservedNotes(rendered, current)}`;
}

function trimTrailingSpace(value: string): string {
  return value.replace(/\s+$/, "");
}

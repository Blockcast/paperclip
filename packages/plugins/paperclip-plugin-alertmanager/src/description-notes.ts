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
  if (current.startsWith(head)) {
    const remainder = current.slice(head.length);
    if (remainder.trim() !== "") return remainder;
  }
  return "\n";
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

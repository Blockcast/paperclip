import { z } from "zod";

/**
 * Schema for the multiline free-text fields (issue descriptions and comments,
 * document bodies, approval notes). It stores what the caller sent, byte for
 * byte.
 *
 * Until PEN-5954 this schema carried a `normalizeEscapedLineBreaks` transform,
 * added in #4444 (2026-04-24) to rescue callers that sent a literal `\n`
 * instead of a JSON-encoded line break. Measured 2026-11-07 on four surfaces
 * (comment body, issue description, issue title, document body): it rewrote
 * `\r\n`, `\n` and `\r` to a single U+000A, left the other 15 escape shapes
 * untouched, and `\\n` collapsed to a backslash plus U+000A — so a caller that
 * meant a literal backslash-n could not express one by any quoting. A correct
 * client already transmits a newline as the JSON escape, which decodes before
 * this schema runs, so the transform could only ever fire on a caller that
 * meant the literal text.
 */
export const multilineTextSchema = z.string();

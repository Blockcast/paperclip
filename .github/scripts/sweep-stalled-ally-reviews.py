#!/usr/bin/env python3
"""Find non-draft open PRs that have been awaiting an Ally review beyond a
threshold, and re-fire the review request.

Why this exists (BLO-22892 / BLO-28203): the reviewer wake fired by
`pull_request.opened` is event-driven and can be silently lost -- the webhook
handler's own `enqueueWakeup` can decline a wake (busy agent, capacity gate,
scheduling suppression) and write a terminal `status="skipped"` row with **no
run and no reconciler**. Ally itself "does not patrol the issue board", so a
lost wake stays lost forever, indistinguishable from one that is merely
waiting its turn. This script is that reconciler -- it runs on a schedule
(not an event), so it does not depend on the same wake path it exists to
backstop.

Ported from `Blockcast/trafficcontrol`'s
`.github/scripts/sweep-stalled-ally-reviews.py` (PR #1383, merged
2026-08-16). Two deliberate differences from that original, both forced by
measurement rather than preference:

1. **The head-attestation predicate is inlined, not imported.** The
   trafficcontrol original does `importlib` on a sibling
   `require-ally-review.py` to reuse its exact-head Ally-signal detection.
   Neither `pim-multicast-gateway` nor `paperclip` has a Python
   `require-ally-review.py` -- the former implements that gate in
   `scripts/require-ally-review.mjs` (JavaScript), the latter has no
   `review/ally-complete` producer at all. So the four predicate pieces are
   carried here verbatim instead. They were verified byte-equivalent in
   behaviour against real Ally bodies on all three repos on 2026-08-20:
   every consolidated review sampled starts `## Ally - Consolidated PR
   Review` and carries a bare `Reviewed head: <40 hex>` line, from login
   `allyblockcast[bot]` with `user.type == "Bot"`.

2. **PREDICATE_MODE selects what "awaiting review" means.** See that constant.

Stdlib only. first_pending_since() / unreviewed_since() / should_refire() /
is_alarming() / ally_has_reviewed_head() are pure -- no network. Only
sweep()/main() talk to the GitHub API, via urllib directly (not the `gh`
CLI, whose presence on the runner is not guaranteed).

Run manually (read-only, writes nothing):
    python3 .github/scripts/sweep-stalled-ally-reviews.py --dry-run
Run tests:
    python3 -m unittest .github/scripts/test_sweep_stalled_ally_reviews.py
"""

import argparse
import http.client
import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Ally head-attestation predicate.
#
# Carried verbatim from trafficcontrol's require-ally-review.py rather than
# imported (see module docstring, difference 1). Keep this block in
# behavioural lockstep with that file: it is the definition of "Ally has
# reviewed this exact revision", and the two drifting apart is precisely how
# a sweep starts re-firing on already-reviewed PRs.
# ---------------------------------------------------------------------------

DEFAULT_ALLY_LOGINS = ["allyblockcast[bot]", "app/allyblockcast", "allyblockcast"]


def parse_list(value, fallback):
    raw = value if value else ",".join(fallback)
    return [item.strip() for item in raw.split(",") if item.strip()]


# Every pattern in this file carries re.ASCII, and that is a parity rule rather
# than a style one. Python's `\b`, `\w` and IGNORECASE folding are all
# Unicode-aware; the gate's regexes are built with "gm"/"gim"/"gi" and never the
# `u` flag, so JavaScript's are ASCII-only. Measured over the whole Unicode
# range at this head: 138495 code points are word characters to Python's `\b`
# and not to JavaScript's, and exactly three -- U+0130, U+0131, U+017F -- fold
# into the ASCII letters these patterns spell. re.ASCII closes both at once and
# cannot be reasoned wrong per site, which an explicit character class can.
# TestPatternCharacterClassesAreAsciiOnly pins the rule for patterns added
# later, including ones using a construct nobody has hit yet.
ASCII_RE = re.ASCII

# Mirrors MARKDOWN_EMPHASIS_RUN / ATTESTATION_WRAPPER_RUN in the gate. Without
# them this reader is *narrower* than the gate on the prose path: of the 25
# attesting bodies on #1721, 3 wrap the SHA in backticks, which the gate reads
# and a bare pattern does not. The indent bound is the gate's NOT_INDENTED_CODE
# for the same reason in the other direction -- an attestation inside an
# indented code block is prose to a bare `[ \t]*` and code to the gate.
MARKDOWN_EMPHASIS_RUN = r"[*_`]{0,3}"
ATTESTATION_WRAPPER_RUN = r"[*_`\t ]{0,6}"

# The immutable head attestation Ally writes into every consolidated body:
# a standalone "Reviewed head: <40 lowercase hex>" line. This is what binds a
# signal to a revision -- NOT review.commit_id, and NOT a substring scan.
REVIEWED_HEAD_PATTERN = re.compile(
    r"^(?! *\t)(?! {4}) {0,3}"
    + MARKDOWN_EMPHASIS_RUN
    + r"[ \t]{0,3}Reviewed head:[ \t]*"
    + ATTESTATION_WRAPPER_RUN
    + r"([0-9a-f]{40})"
    + ATTESTATION_WRAPPER_RUN
    + r"[ \t]*$",
    re.IGNORECASE | re.MULTILINE | ASCII_RE,
)


# Ally's structured verdict block -- the primary source, mirroring
# server/src/services/ally-review-detection.ts so this reader and the merge gate
# cannot disagree about which tree was reviewed. The prose line above is the
# fallback for a body that carries no block.
VERDICT_BLOCK_PATTERN = re.compile(
    # `[0-9]`, never `\d`: Python's `\d` is Unicode-aware and JavaScript's is
    # ASCII-only, so `ally-verdict:١` (U+0661) parses as version 1 here and
    # matches nothing in either JS reader. The gate then counts an opener with
    # no block and goes `unreadable_verdict` while this sweep records the head
    # as reviewed -- verbatim the divergence `parse_verdict_block_head` below
    # exists to prevent. Same rule at EMITTED_BUCKET_PATTERN, where it inverts.
    r"^(?! *\t)(?! {4}) {0,3}(?![ \t]*>)<!--[ \t]*ally-verdict:[ \t]*([0-9]+)(.*?)-->",
    re.MULTILINE | re.DOTALL | ASCII_RE,
)
VERDICT_OPENER_PATTERN = re.compile(
    r"^(?! *\t)(?! {4}) {0,3}(?![ \t]*>)<!--[ \t]*ally-verdict\b", re.MULTILINE | ASCII_RE
)
SUPPORTED_VERDICT_VERSION = 1
FULL_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE | ASCII_RE)
# Ledger entries name the head they were raised at as Ally wrote it, which is
# abbreviated. Mirrors the bound in `asDispositions` / `stillPresentIn`.
ABBREV_SHA_PATTERN = re.compile(r"^[0-9a-f]{7,40}$", re.IGNORECASE | ASCII_RE)

# Mirrors BLOCKING_SEVERITIES / VERDICT_SEVERITIES / MAX_VERDICT_FINDING_COUNT
# in ally-review-detection.ts. A block whose counts that reader rejects must be
# unreadable here too, or this sweep sees an attestation where the gate sees a
# broken verdict -- and then declines to re-request the one review that could
# clear the red.
BLOCKING_SEVERITIES = ("critical", "important")
VERDICT_SEVERITIES = frozenset(BLOCKING_SEVERITIES + ("suggestions",))
MAX_VERDICT_FINDING_COUNT = 1000

# A counted bucket the review *emits*, e.g. `### Critical Issues (2)`. Anchored
# to the emitted heading form for the reason the module's copy is: an
# unanchored bucket also matches a sentence *referencing* an earlier pass's
# counts, and over-matching fails a clean review closed.
EMITTED_BUCKET_PATTERN = re.compile(
    r"^(?! *\t)(?! {4}) {0,3}(?![ \t]*>)(?:#{1,6}[ \t]*)?[*_]{0,3}"
    # `[0-9]` for the reason given at VERDICT_BLOCK_PATTERN, and here the harm
    # runs the other way: `### Critical Issues (١)` over a block stating 0 is
    # no bucket at all to the JS readers -- no contradiction, gate green --
    # while Unicode `\d` would make it a contradiction here, sending the sweep
    # to re-request review on a head Ally already reviewed.
    r"(Critical|Important)[ \t]+Issues[ \t]*[*_]{0,3}[ \t]*\(([0-9]+)\)[*_]{0,3}[ \t]*$",
    re.IGNORECASE | re.MULTILINE | ASCII_RE,
)

# A prose ledger entry, e.g. `- **prior:abc1234 critical 1** - still-present -`.
# Composed character-for-character as PRIOR_FINDING_DISPOSITION_PATTERN in
# ally-review-detection.ts, including the `(?! *\t)(?! {4})` indentation bound
# and the em/en/hyphen alternation. `[0-9]` rather than `\d` for the reason
# given at EMITTED_BUCKET_PATTERN, and the harm runs the same way here: a
# Unicode digit is no ledger entry at all to the JS readers, so widening it
# would send this sweep to re-request a review Ally already gave.
#
# Strict rather than reusing the looser `**prior:[^\n]***` form in
# check-ally-review-consistency.mjs. That reader is an auditor, where
# over-matching costs a reported violation; here it costs a duplicate review
# request, which is the BLO-22892/BLO-28203 loop.
PRIOR_FINDING_DISPOSITION_PATTERN = re.compile(
    r"^(?! *\t)(?! {4}) {0,3}-[ \t]*\*\*[ \t]*prior:[0-9a-f]{7,40}[ \t]+[a-z]+[ \t]+[0-9]+"
    r"[ \t]*\*\*[ \t]*(?:—|–|-)[ \t]*([a-z][a-z-]*)[ \t]*(?:—|–|-)",
    re.IGNORECASE | re.MULTILINE | ASCII_RE,
)

# The verb that asserts a prior finding still stands. Mirrors
# BLOCKING_PRIOR_DISPOSITIONS in check-ally-review-consistency.mjs and the
# `blocks` arm of classifyPriorDisposition in ally-review-detection.ts. An
# unrecognized verb is deliberately not blocking in any of the three.
BLOCKING_PRIOR_DISPOSITIONS = frozenset(("still-present",))

FENCE_OPEN_PATTERN = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$", ASCII_RE)
FENCE_CLOSE_PATTERN = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*$", ASCII_RE)


def review_text(body):
    """The body with every line ending normalized to `\\n`.

    The single entry point for every reader below, mirroring reviewBody in
    ally-review-detection.ts and reviewText in check-ally-review-consistency.mjs.
    Python's `.` matches `\\r` where JS's does not, so on a CRLF body
    FENCE_OPEN_PATTERN opened a fence FENCE_CLOSE_PATTERN could never close and
    this blanked to end of body while both JS readers blanked nothing: one
    review, three verdicts, and this sweep never re-requested the review that
    would clear the gate's red (Ally, #1721 at 5f4d5302, Critical 3).
    """
    return re.sub(r"\r\n?", "\n", body or "")


def without_fenced_spans(text, keep_unterminated=False):
    """Blank fenced spans so a quoted bucket cannot fail a block closed.

    `keep_unterminated` mirrors the gate's: a fence that never closes is left
    as emitted text, for the fail-closed count and ledger cross-checks only,
    because blanking it hid the bucket that contradicts the block (Ally, #1721
    at 5f4d5302, Important 1).

    Mirrors withoutFencedCodeBlocks in the gate exactly -- tilde fences, fence
    length matching and the backtick info-string rule. A simpler toggle here is
    not a scoping choice but a divergence: the two readers then disagree about
    how many blocks a body contains, which is the BLO-31730 cross-reader
    failure one layer down, and it fires first on a review that quotes the
    marker template -- the likeliest shape for a review of this feature.
    Applied to the count cross-check, to the block and opener counts in
    parse_verdict_block_head, and to the prose attestation in
    parse_reviewed_head.
    """
    if "```" not in text and "~~~" not in text:
        return text
    lines = []
    open_fence = None
    opened_at = -1
    for line in text.split("\n"):
        if open_fence:
            close = FENCE_CLOSE_PATTERN.match(line)
            lines.append("")
            if close and close.group(1)[0] == open_fence[0] and len(close.group(1)) >= open_fence[1]:
                open_fence = None
            continue
        fence = FENCE_OPEN_PATTERN.match(line)
        # Per CommonMark a backtick fence's info string may not itself contain
        # a backtick. Honoring that keeps an inline span from opening a phantom
        # fence that would blank the rest of a genuine review.
        if fence and not (fence.group(1)[0] == "`" and "`" in fence.group(2)):
            open_fence = (fence.group(1)[0], len(fence.group(1)))
            opened_at = len(lines)
            lines.append("")
        else:
            lines.append(line)
    # An unclosed fence blanks to end of body, matching how GitHub renders it.
    if open_fence and keep_unterminated:
        return "\n".join(lines[:opened_at] + text.split("\n")[opened_at:])
    return "\n".join(lines)


# The exact character set ECMAScript's String.prototype.trim removes:
# WhiteSpace (TAB, VT, FF, ZWNBSP, and the Space_Separator category) plus
# LineTerminator (LF, CR, LS, PS). Python's str.strip() is a different set in
# *both* directions -- it removes U+001C..U+001F and U+0085, which JS keeps,
# and it keeps U+FEFF, which JS removes -- so a bare .strip() on any field this
# reader shares with the JS readers is the same class of divergence as `\d`.
JS_WHITESPACE = (
    # WhiteSpace: TAB, VT, FF, ZWNBSP ...
    "\u0009\u000b\u000c\ufeff"
    # ... and the Space_Separator (Zs) category.
    "\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005"
    "\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000"
    # LineTerminator: LF, CR, LS, PS.
    "\u000a\u000d\u2028\u2029"
)


def js_trim(value):
    """`String.prototype.trim`, not `str.strip`. See JS_WHITESPACE."""
    return value.strip(JS_WHITESPACE)


def reject_js_nonfinite(literal):
    """Make json.loads refuse what JSON.parse refuses.

    Python accepts the bare `NaN`/`Infinity`/`-Infinity` literals as a JSON
    extension; `JSON.parse` raises on all three. The counts and ledger indices
    are already held to `is_js_integer`, so the gap is only reachable through a
    key no reader validates -- but the block's own comment anticipates a future
    free-text field, and one extra key carrying `NaN` would read `ok` here and
    `unreadable` at the gate. Closing it at the parser costs one argument and
    cannot rot as fields are added.
    """
    raise ValueError("JSON.parse rejects the %s literal" % literal)


def is_js_integer(value):
    """Whether `Number.isInteger` would accept this JSON value.

    `isinstance(value, int)` is not that predicate, and the gap splits this
    reader from both JS readers in the direction that hurts. `json.loads`
    yields floats for `0.0`, `0e0` and `1e3`, every one of which is an integer
    to `Number.isInteger`; `isinstance(0.0, int)` is False, so a
    float-formatted count or ledger index read `unreadable` here while the gate
    and the mjs read `ok`. Consequence is the loop the docstring on
    parse_verdict_block_head names: no attestation here -> the sweep re-requests
    a review of a head Ally already reviewed, and a `COMMENTED` duplicate cannot
    be dismissed (Ally review of #1721 at bbe6d640; BLO-22892/BLO-28203).

    bool stays rejected: it is an int subclass here and not a number in JS. An
    int too large for float64 parses as Infinity in JS, where Number.isInteger
    is False -- OverflowError from float() is that same answer, so it is caught
    rather than special-cased.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return float(value).is_integer()
    except OverflowError:
        return False


def severity_counts(raw):
    """Per-severity counts, or None when the payload cannot be trusted.

    Absent counts are not zero counts and an unknown severity key is not a key
    to drop; both are routes by which a block claiming a finding reads
    identically to a clean one.
    """
    if not isinstance(raw, dict):
        return None
    counts = {}
    for severity, value in raw.items():
        if not is_js_integer(value):
            return None
        if value < 0 or value > MAX_VERDICT_FINDING_COUNT:
            return None
        key = js_trim(severity).lower() if isinstance(severity, str) else None
        if key not in VERDICT_SEVERITIES:
            return None
        # Two keys normalizing to one severity: last-wins would let
        # {"critical":1,"Critical":0} read clean. Mirrors the guard in
        # ally-review-detection.ts and check-ally-review-consistency.mjs -- all
        # three readers shared the bug identically, so none of them caught it.
        if key in counts:
            return None
        counts[key] = value
    if any(severity not in counts for severity in BLOCKING_SEVERITIES):
        return None
    return counts


def dispositions_ok(payload):
    """Whether the ledger is readable, mirroring `asDispositions` field for field.

    Takes the whole payload, not `payload["dispositions"]`, because absent and
    explicitly-null are different answers and `.get()` collapses them. Both JS
    readers key on `undefined`: an absent ledger is legitimate (a review that
    retires nothing emits none) and reads as empty, while an explicit `null`
    fails `Array.isArray` and reads as unreadable. Taking the dict is what lets
    `"dispositions" in payload` tell those apart; passing the value could not.

    This reader never uses the entries -- it only wants the head -- but it must
    still agree with the other two about whether the block is readable at all.
    Without this the validation covered one of the two fields the payload
    carries: TS rejects a malformed ledger (`asDispositions` -> None ->
    unreadable) and so does the mjs (`stillPresentIn`), while this dropped
    through to ("ok", head).

    That is the exact harm named in the comment justifying why `findings` is
    validated here, and worse in this direction: the gate goes red on
    `unreadable_verdict` while this sweep sees a review that already happened,
    so it never re-requests the one that would clear it -- and the sweep is the
    only automatic route back. Found in peer review of #1721 at 97b4ddd1 with
    `{"head": "<40-hex>", "findings": {...}, "dispositions": "nope"}`:
    ("ok", head) here, `failure` at the gate.
    """
    if "dispositions" not in payload:
        return True
    raw = payload["dispositions"]
    if not isinstance(raw, list):
        return False
    for item in raw:
        if not isinstance(item, dict):
            return False
        head = item.get("head")
        if not isinstance(head, str) or not ABBREV_SHA_PATTERN.match(js_trim(head)):
            return False
        for field in ("severity", "verb"):
            value = item.get(field)
            if not isinstance(value, str) or not js_trim(value):
                return False
        index = item.get("index")
        # Same JS-integer predicate as the counts above, for the same reason:
        # `"index": 1.0` is an integer to the gate and to the mjs.
        if not is_js_integer(index) or index < 1:
            return False
    return True


def prose_count_contradicts(text, counts):
    """An emitted bucket counting more than the block states -- mirrors
    proseCountContradicting in ally-review-detection.ts. Any shortfall, not
    only against a stated zero (Ally, #1721 at 5f4d5302, Important 2)."""
    for severity, count in EMITTED_BUCKET_PATTERN.findall(without_fenced_spans(text, keep_unterminated=True)):
        key = severity.lower()
        if key in BLOCKING_SEVERITIES and int(count) > counts[key]:
            return True
    return False


def prose_disposition_contradicts(text, payload):
    """A prose ledger entry that still stands against a block retiring them all.

    Mirrors proseDispositionContradicting in ally-review-detection.ts. The gate
    reads `dispositions` for a blocking verb exactly as it reads `findings` for
    a non-zero count, so a block whose ledger is absent, `[]`, or merely missing
    the entry suppresses a prose entry saying a prior finding stands. Without
    this the gate goes red on `unreadable_verdict` while this sweep sees a
    review that already happened and never re-requests the one that would clear
    it -- the same asymmetry the `findings` check above exists for.

    Asymmetric like that one: a block already carrying a blocking verb cannot
    fail open, so the prose is not consulted, and a prose entry that only
    retires clears either way.
    """
    for entry in payload.get("dispositions") or ():
        verb = entry.get("verb") if isinstance(entry, dict) else None
        if isinstance(verb, str) and js_trim(verb).lower() in BLOCKING_PRIOR_DISPOSITIONS:
            return False
    for verb in PRIOR_FINDING_DISPOSITION_PATTERN.findall(without_fenced_spans(text, keep_unterminated=True)):
        if verb.lower() in BLOCKING_PRIOR_DISPOSITIONS:
            return True
    return False

# Mirrors ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN in ally-review-detection.ts
# piece for piece -- `#{1,6}` or `**`, the em/en/hyphen/colon separator,
# `[ \t]+` between words, the NOT_INDENTED_CODE bound -- and is searched over
# fence-stripped text as the gate's emittedReviewText is. The looser
# `##[ \t]*Ally\b.*Consolidated PR Review` it replaces split from the gate in
# both directions: it missed the `###`, `#`, bold and bare forms the gate
# credits, so the sweep re-requested a review of a head Ally had already
# reviewed (the BLO-22892/BLO-28203 loop), and it accepted `##Ally`, `--` and
# indented-code forms the gate does not (Ally, #1721 at 2dfdfafe, Important 1).
# Pinned by "the sweep's consolidated heading is the gate's" in
# scripts/check-ally-review-consistency.test.mjs.
CONSOLIDATED_HEADING_PATTERN = re.compile(
    r"^(?! *\t)(?! {4}) {0,3}(?:#{1,6}[ \t]+|\*\*[ \t]*)?Ally[ \t]*(?:—|–|-|:)[ \t]*Consolidated[ \t]+PR[ \t]+Review\b",
    re.IGNORECASE | re.MULTILINE | ASCII_RE,
)


def parse_verdict_block_head(body):
    """Return ("ok", head) / ("absent", None) / ("unreadable", None).

    "absent" means fall back to the prose line. "unreadable" means a block is
    present but cannot be trusted, and must NOT fall back -- falling back would
    put the retired prose regex back on the critical path for exactly the
    bodies the block exists to carry.

    Counted over fence-stripped text, because the gate counts over fence-stripped
    text: parseAllyVerdictBlock reads emittedReviewText(body). Reading the raw
    body here made a fenced ```markdown example of the marker a *second* block --
    gate blocks=1/openers=1 -> ok, this reader blocks=2/openers=2 -> unreadable,
    on one body. The consequence is the one this file's own docstring at the
    stalled-review check names: with ally_has_reviewed_head false the sweep
    re-fires a request on a head Ally already reviewed, and each duplicate is a
    COMMENTED review that cannot be dismissed -- "spam, and eventually a false
    alarm, not reconciliation". It fires first on a review quoting the template,
    which is the likeliest shape for a review *of this feature* (found in peer
    review of #1721 at 97b4ddd1).

    The count and ledger cross-checks read the body with an unterminated fence
    kept as emitted text, as the gate's do.
    """
    body = review_text(body)
    text = without_fenced_spans(body)
    blocks = VERDICT_BLOCK_PATTERN.findall(text)
    openers = VERDICT_OPENER_PATTERN.findall(text)
    # An opener with no terminator is a truncated payload, not an older review.
    if len(openers) > len(blocks):
        return ("unreadable", None)
    if not blocks:
        return ("absent", None)
    if len(blocks) > 1:
        return ("unreadable", None)
    raw_version, raw_payload = blocks[0]
    # int, not string: the two JS readers use `Number(raw)`, so a string
    # compare would split them on `ally-verdict:01` -- readable to the gate,
    # unreadable here, and this sweep would re-request a review that already
    # happened. Cross-reader divergence is the BLO-31730 failure.
    if int(raw_version) != SUPPORTED_VERDICT_VERSION:
        return ("unreadable", None)
    try:
        parsed = json.loads(js_trim(raw_payload), parse_constant=reject_js_nonfinite)
    except ValueError:
        return ("unreadable", None)
    if not isinstance(parsed, dict):
        return ("unreadable", None)
    head = parsed.get("head")
    if not isinstance(head, str) or not FULL_SHA_PATTERN.match(js_trim(head)):
        return ("unreadable", None)
    # The counts the gate reads, read here too. A block whose findings that
    # reader rejects -- or whose own emitted buckets contradict it -- is a
    # broken verdict, and a broken verdict attests nothing. Without this the
    # gate is red on `unreadable_verdict` while this sweep sees a review that
    # already happened and never re-requests the one that would clear it.
    counts = severity_counts(parsed.get("findings"))
    if counts is None:
        return ("unreadable", None)
    # The other field the payload carries, held to the same rule.
    if not dispositions_ok(parsed):
        return ("unreadable", None)
    if prose_count_contradicts(body, counts):
        return ("unreadable", None)
    # The same rule on the other field the payload carries.
    if prose_disposition_contradicts(body, parsed):
        return ("unreadable", None)
    return ("ok", js_trim(head).lower())


def parse_reviewed_head(body):
    """Return the single attested head OID, or None.

    The structured block wins when present. Prose is the fallback and requires
    EXACTLY ONE standalone attestation line: zero means the body makes no claim
    about which revision it covers, more than one is ambiguous. Both fail closed
    -- the caller treats them as "not a signal for this head".

    Asymmetric on purpose, matching `extractAllyReviewedHeadSha`: only a prose
    line *disagreeing* with the block is fatal. An absent or unparseable prose
    line is not -- that is the #1675 body (an attested SHA trailed by a
    parenthetical), which the prose regex cannot read.
    """
    kind, block_head = parse_verdict_block_head(body)
    if kind == "unreadable":
        return None
    # Over the fence-stripped text, as the gate reads it. The raw body let one
    # fenced copy of the attestation make the prose ambiguous here while the
    # gate read the emitted line and failed the block on disagreement, so the
    # sweep saw a review the gate cannot read and never re-requested it (Ally,
    # #1721 at 5f4d5302, Important 3).
    matches = REVIEWED_HEAD_PATTERN.findall(without_fenced_spans(review_text(body)))
    prose_head = matches[0].lower() if len(matches) == 1 else None
    if kind == "absent":
        return prose_head
    if prose_head is not None and prose_head != block_head:
        return None
    return block_head


def attests_head(body, head_sha):
    """Exact equality against the parsed attestation.

    Deliberately not a substring test: a body that reviewed revision X but
    happens to mention revision Y in prose ("superseded by Y") must not count
    as a signal for Y.
    """
    attested = parse_reviewed_head(body)
    return attested is not None and attested == head_sha.lower()


def is_consolidated_ally_comment_for_head(body, head_sha):
    # Not `startswith`: the verdict block legitimately precedes the heading, so
    # anchoring on "## Ally" being the first byte misses Ally's own emitted
    # bodies. Require the heading on its own line instead.
    return (
        CONSOLIDATED_HEADING_PATTERN.search(without_fenced_spans(review_text(body))) is not None
        and attests_head(body, head_sha)
    )


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

STATUS_CONTEXT = os.environ.get("STATUS_CONTEXT") or "review/ally-complete"

# What counts as "this PR is awaiting an Ally review".
#
#   "status"      -- the head's `review/ally-complete` commit status has been
#                    continuously `pending` past STALL_THRESHOLD_SECONDS.
#                    Requires the repo to actually run that gate.
#   "status-free" -- no `review/ally-complete` status is consulted at all.
#                    A PR is awaiting review when it is open, non-draft, and
#                    Ally has produced no consolidated report for the exact
#                    head, for longer than STALL_THRESHOLD_SECONDS measured
#                    from unreviewed_since().
#
# Why the mode exists rather than two forked scripts: measured 2026-08-20,
# `Blockcast/paperclip` has **0 of 100** open PRs carrying a
# `review/ally-complete` status -- it has no producer for that context, so a
# status-keyed sweep there would consider every PR "not pending" and silently
# do nothing forever. That is the failure this reconciler exists to prevent,
# reintroduced one layer up. `Blockcast/pim-multicast-gateway` does run the
# gate (17 of 42 open PRs carried the status at the same measurement) and
# keeps the cheaper status filter.
#
# The status filter is only ever an OPTIMISATION. ally_has_reviewed_head()
# below is the load-bearing half in BOTH modes, and it is the half carrying
# the Bot-identity check that is the actual BLO-22892 false negative.
PREDICATE_MODE = (os.environ.get("PREDICATE_MODE") or "status").strip().lower()
if PREDICATE_MODE not in ("status", "status-free"):
    raise SystemExit("PREDICATE_MODE must be 'status' or 'status-free', got %r" % PREDICATE_MODE)

ALLY_REVIEWER_LOGINS = parse_list(os.environ.get("ALLY_REVIEWER_LOGINS"), DEFAULT_ALLY_LOGINS)

# The login to request a formal GitHub review from when re-firing. Live
# evidence from BLO-22892 (2026-08-08): the marker-comment re-fire had been
# sent 3 times over several hours against 5 stranded PRs with zero effect,
# while requesting a review from this exact login via
# `POST .../requested_reviewers` (a genuine `pull_request.review_requested`
# event, not an `issue_comment`) produced a real Ally review on 4/4 PRs tried
# within 3-8 minutes each. Kept configurable so a login rename doesn't
# require a code change, but defaults to the User identity proven to work.
ALLY_REQUEST_REVIEWER_LOGIN = os.environ.get("ALLY_REQUEST_REVIEWER_LOGIN") or "allyblockcast"

# How long a head must have been awaiting review before we consider it
# stranded rather than "just waiting its turn".
#
# THIS NUMBER IS CALIBRATION AND IT ROTS. Re-derive it, do not inherit it.
# The threshold measures `unreviewed_since()` -> review: WEBHOOK LAG + QUEUE
# WAIT + SERVICE + REVIEW-WRITING. Measure that, not any one term of it.
# It was originally set to 90m from BLO-22892's figures of 6m35s and 30m --
# but those are SERVICE time (`startedAt` -> review), measured when the wake
# landed promptly. Queue wait was negligible then and dominates now by an
# order of magnitude, so the old number had become a constant-true predicate:
# "stranded" meant "dispatched normally", and every re-fire woke a PR author
# for nothing.
#
# Measured 2026-09-18 (BLO-34521), window 2026-09-16T22:37Z -> 2026-09-18T05:50Z,
# n=706 started Ally `pr_review:` runs, wait = `startedAt - createdAt`:
#
#     p50 268m (4h28m) | p90 338m | max 405m | min 45m
#     > 90m: 697/706 = 99%
#
# plus 107 `pr_review` runs still QUEUED at observation: median age 201m,
# max age 408m. Report that tail, because it is what censors the sample.
# A queued run's eventual wait is unknown but strictly GREATER than its
# current age, and long waits are disproportionately the ones still queued
# when you look -- so `max 405m` over the started cohort is a biased-LOW
# estimate of the population max, over a sample ~13% censored (107/813).
#
# Reproduce with:
#
#     GET /companies/{companyId}/heartbeat-runs?agentId=<ally>&limit=1000
#     keep runs whose `contextSnapshot.taskKey` starts with "pr_review:"
#     wait = startedAt - createdAt   (queued runs: now - createdAt; report
#     those separately -- they are a lower bound, not an observation)
#
# RE-MEASURED 2026-09-19 (BLO-34521), window 2026-09-17T19:19Z ->
# 2026-09-18T21:54Z, n=725 started, same query:
#
#     p50 187m | p90 355m | max 462m | min 6m
#     > 90m: 698/725 = 96%   |   > 8h: 0/725 = 0%
#
# and the censored tail had largely drained: 114 still queued, median age
# 94m, max age 185m (was max 408m). So 462m is a far less biased estimate of
# the population max than the first window's 405m -- and it is HIGHER, which
# is the direction that matters. Two independent windows now agree that 8h
# sits outside the distribution: 0% breach on both.
#
# *** BOTH WINDOWS ABOVE MEASURE THE WRONG QUANTITY. They are kept because
# they are a valid LOWER BOUND, and because the gap between them and the
# right quantity is the whole lesson here. ***
#
# Dispatch wait is `startedAt - createdAt`. This threshold is compared
# against `unreviewed_since()` -- max(PR opened, head commit landed) -- so
# the interval it actually clocks is head-landed -> review posted, which is
# webhook lag + queue wait + service + the time Ally spends writing the
# review. Dispatch wait is one term of four. An 8h value derived from it was
# never calibrated against the predicate it gates; the paragraph this
# replaced conceded the gap ("does NOT also claim a separate service-time
# buffer on top") and then treated it as a rounding margin. It is not one.
#
# MEASURED DIRECTLY 2026-09-19 (BLO-34521), `Blockcast/paperclip`, the last
# 100 PRs, n=232 first-Ally-review-per-head pairs, window 2026-09-13T17:37Z
# -> 2026-09-19T05:25Z, wait = review_submitted - unreviewed_since:
#
#     p50 4.09h | p90 12.70h | p95 17.20h | max 30.81h | min 0.05h
#     > 90m: 178/232 = 77%   |   > 8h: 45/232 = 19.4%
#     > 18h:  11/232 = 4.7%  |   > 22h (ALARM): ~3% ESTIMATED
#
# The ALARM cell is the one soft number here -- estimated, not counted, which
# is why it is the only cell without an exact numerator. It is not unbounded,
# though, and the bound is what to reason from: the table is a survival
# function, so `> 22h` is a SUBSET of `> 18h` and is therefore at most 11/232
# = 4.7%. The ~3% only estimates where inside that band it falls. Quote the
# 4.7% when the number has to carry weight -- it is counted and reproducible
# from the cells as printed. Give the cell its own numerator on the next full
# re-run of the reproduction below, and delete this note when you do.
#
# So 8h breached on 19.4% of HEALTHY reviews -- against an acceptance
# criterion of under ~10%. Measured against dispatch wait the same value
# breached 0%. The instrument, not the number, was the defect.
#
# Reproduce with (no Paperclip credential needed, unlike the query above --
# this one reads only GitHub, which is what makes it the reproducible one):
#
#     for each recent PR: reviews + `^## Ally` comments authored by the Ally
#     App identity, keep those carrying a head SHA (`commit_id`, or the
#     `Reviewed head: <40-hex>` line); take the EARLIEST review per
#     (pr, head) -- the predicate is satisfied by the first one;
#     wait = review_time - max(pr.created_at, commit.committer.date)
#
# Corroborated independently on `Blockcast/Network-Operator-Portal` the same
# day (BLO-34617, TrafficOpsEngineer): marker -> review over n=50 served
# pairs gave p50 4.26h against p50 4.09h here -- a near-exact match on two
# repos by two different methods, which is what promotes this from one
# sample to a property of the fleet rather than of this repo.
#
# 18h is picked off p90, not off the max: 1080m is 1.417x the 762m p90, and
# the dispatch-wait derivation used 1.420x (480/338) -- the same multiplier to
# the precision either sample supports. Quote it to 3dp, not 2: rounding this
# UP to "1.42x" states a margin 18h does not actually clear, and the guard
# below asserts the stated figure. Chasing the max instead would mean 32h --
# a day and a half to detect a lost review, bought against the 11/232 (4.7%)
# that sit above 18h, which is the band that move actually covers. ("A tail of
# 3 PRs" stood here through two revisions and reconciles with no cell in the
# table above; read the band off the table, do not carry a figure forward.)
# The failure direction is benign (understating the ceiling
# costs a false re-fire, never a missed loss), so the MULTIPLIER is the thing
# to re-derive, not the max. The floor this must clear is asserted in
# TestStallThresholdCalibration; update that table in the same commit that
# changes this constant, and add the quantity you measured -- a row labelled
# `dispatch-wait` alone is what let 8h pass its own guard.
#
# The upward drift is not noise: its root cause is BLO-19881 (fleet-wide
# heartbeat queue starvation concentrated on Ally). If that lands, this
# number should come back DOWN -- a threshold this far above a recovered
# queue is slow loss detection. Re-derive after it, not just before.
#
# KNOWN CEILING -- elapsed time is structurally the wrong instrument. It
# cannot distinguish a LOST wake from a merely QUEUED one, which is the only
# distinction that matters here: no elapsed-time value separates them, so any
# value is a trade between false author-wakes and slow loss detection. The
# sound discriminator is the `heartbeat_run` row for this request's
# `pr_review:<repo>:<n>` taskKey, and it is a THREE-state read, not two:
#
#     no row at all          -> the wake never landed: genuinely lost
#     queued or running row  -> dispatch is healthy SO FAR
#     terminal row, no review -> lost, and the alarm must still fire
#
# The third state is not hypothetical: `process_lost` and
# `external_lifecycle_stale_killed` are live wake reasons on this fleet, so a
# run can be created, start, and die mid-flight without posting a review.
# Reading row-exists as health would call that healthy forever -- a false
# negative in the same direction as the bug this script backstops.
# review-gate-sweep.yml carries only `GITHUB_TOKEN` and no Paperclip
# credential, so that check is unreachable from CI today; granting the sweep
# API access is a strictly larger blast radius and belongs in its own row.
STALL_THRESHOLD_SECONDS = int(os.environ.get("STALL_THRESHOLD_SECONDS") or 18 * 60 * 60)

# Don't re-fire more than once per cooldown window even if still stalled --
# the sweep itself must not become the burst that re-triggers whatever
# capacity gate declined the original wake. A human/agent can still re-fire
# manually inside the cooldown; this only throttles the AUTOMATED re-ask.
REFIRE_COOLDOWN_SECONDS = int(os.environ.get("REFIRE_COOLDOWN_SECONDS") or 2 * 60 * 60)

# How often the sweep runs, mirroring `cron: '9 * * * *'` in
# review-gate-sweep.yml. Used ONLY to state the rotation coverage bound in the
# run summary (MAX_REFIRES_PER_RUN x cooldown/interval; see PEN-3589) -- no
# decision reads it, so drift against the workflow misstates one sentence
# rather than changing any behaviour. Kept here rather than parsed from the
# workflow because a YAML cron parser is far more machinery than one
# operator-facing figure is worth.
#
# Clamped to at least 1s for the same reason MAX_REFIRE_ATTEMPTS_PER_RUN is
# clamped: it is operator-settable, it is a DIVISOR at the coverage-bound
# print, and that print happens AFTER the run's writes have landed. An
# unclamped 0 raises ZeroDivisionError there, which the top-level handler does
# not catch (it takes RateLimitExhausted/HTTPError/URLError), so a stray env
# value would turn a fully-successful sweep into a bare traceback.
SWEEP_RUN_INTERVAL_SECONDS = max(1, int(os.environ.get("SWEEP_RUN_INTERVAL_SECONDS") or 60 * 60))

# Ceiling on re-fires per run. The trafficcontrol original needed no such cap:
# its status pre-filter naturally bounded the candidate set to heads a gate
# had recently touched. `status-free` mode has no such bound -- on a repo with
# a long tail of old open PRs the FIRST run would otherwise request a review
# on every one of them at once, which is the thundering herd this script's own
# cooldown exists to avoid. Over-limit PRs are not dropped silently: they are
# reported as deferred, still counted in `considered`, and still alarm.
MAX_REFIRES_PER_RUN = int(os.environ.get("MAX_REFIRES_PER_RUN") or 5)

# Ceiling on re-fire ATTEMPTS per run. MAX_REFIRES_PER_RUN counts re-fires
# that were actually DELIVERED, so a PR whose write fails does not consume a
# slot -- otherwise a permanently-failing PR would hold rank 0 forever (no
# marker is posted on failure, so its cooldown never engages and its wait
# keeps growing), and MAX_REFIRES_PER_RUN such PRs would starve the budget
# every run. That fall-through has to stop somewhere or a run where every
# write fails would attempt the entire eligible set, so this bounds the
# extra calls.
#
# 2x the delivery cap. Each re-fire costs up to 4 requests -- request_review
# does GET + conditional DELETE + POST (it withdraws an existing request
# before re-issuing it, see its docstring), then the marker comment POST -- so
# the worst case is 40 requests, 30 of them writes, against github.token's
# 1,000/hour/repository budget. The 4-request branch is the steady state
# rather than the corner: a COMMENTED review does not clear a review request,
# so the PRs this sweep re-fires are exactly the ones that keep one
# outstanding, and the conditional DELETE fires. Negligible beside the ~359
# reads a run already makes (see review-gate-sweep.yml's rate-limit
# arithmetic, which is unchanged by this -- that note's ~270 is the same
# 3-reads-per-PR method over a hypothetical 90 open PRs, not a competing
# figure). It tolerates up to MAX_REFIRES_PER_RUN persistently-failing PRs
# while still delivering a full budget to healthy ones.
#
# Clamped to at least the delivery cap. An operator-set value below it would
# make MAX_REFIRES_PER_RUN unreachable, and the deferral message would then
# name the attempt ceiling while implying the delivery budget had been spent.
# The clamp makes that state unrepresentable rather than merely unlikely.
MAX_REFIRE_ATTEMPTS_PER_RUN = max(
    MAX_REFIRES_PER_RUN,
    int(os.environ.get("MAX_REFIRE_ATTEMPTS_PER_RUN") or 2 * MAX_REFIRES_PER_RUN),
)

# Absolute floor at which the WRITE pass alone marks a run degraded.
#
# "WRITE pass" names the PASS, not the write call: the expression at its use
# site counts BOTH refire_write_failures and refire_recheck_failures, because
# both arise in pass 2 and both spend the same ceiling (the re-check is
# counted against MAX_REFIRE_ATTEMPTS_PER_RUN at its own guard, `attempted +
# recheck_failures >= ...`). Sharing the ceiling is the entire argument for an
# absolute floor, so a bucket that shares the ceiling shares the floor. The
# name is kept over REFIRE_PASS_DEGRADED_FLOOR because the boundary that
# matters here is pass 1 vs pass 2 -- read population vs bounded population --
# and "write pass" is how the rest of this file draws it.
#
# The read pass is judged proportionally (sweep_is_degraded), which is right
# for a population whose size is the open-PR count. The write pass is NOT that
# population: it is hard-capped at MAX_REFIRE_ATTEMPTS_PER_RUN just above, so
# past ~100 open PRs a proportional threshold rises above that ceiling and
# becomes unreachable -- every write can fail and the run still exits 0. A
# bounded population needs a bounded trigger.
#
# 3 matches sweep_is_degraded's own floor, and is a majority of the
# MAX_REFIRES_PER_RUN=5 a healthy run delivers, so it reads as "the write side
# is systematically failing" rather than one transient rejection.
WRITE_PASS_DEGRADED_FLOOR = 3

# BLO-22892 AC4: the stranded condition must be visible without a human
# noticing by hand. A re-fired request can itself go unserviced (that's the
# whole failure mode this script backstops), so "we re-fired it" is not
# evidence of health. Once a head has been awaiting review long enough that at
# least one automated re-fire + its cooldown should have resolved it, the
# sweep fails its own CI check -- turning silence into a persistently red
# scheduled run, rather than a status nobody is watching. Deliberately >
# STALL_THRESHOLD_SECONDS + REFIRE_COOLDOWN_SECONDS by a margin.
#
# What this alarm does and does not claim: it fires on "this head has been
# awaiting review past the alarm threshold", WHATEVER the cause. It does not
# check that a re-fire was actually attempted first -- `is_alarming` reads
# only `is_draft` and `pending_since`, never `existing_marker_epochs`. The
# margin makes "the re-fire didn't work either" the *typical* cause once the
# sweep has been running continuously, but that is not guaranteed on cold
# start, after a schedule gap, or for a PR repeatedly deferred past
# MAX_REFIRES_PER_RUN. Gating the alarm on a prior marker was considered and
# rejected: it would silence the alarm on exactly the runs where the sweep
# itself was not working, which is the wrong direction to fail.
#
# The margin is STALL + COOLDOWN + 2h, one hour wider than trafficcontrol's
# +1h, because this repo's sweep runs HOURLY rather than every 30 minutes
# (see review-gate-sweep.yml for the rate-limit arithmetic behind that). The
# extra hour is the polling granularity: worst case a head goes stale just
# after a run, so with STALL at 18h its first re-fire lands at 1080m+60m=1140m.
# Its cooldown then expires at 1260m, and the boundary is INCLUSIVE --
# `should_refire` blocks only on `since_last < REFIRE_COOLDOWN_SECONDS`, so
# the hourly run at exactly 1260m is already eligible. The formula gives 1320m
# (22h), clearing that second re-fire opportunity by a full hour rather than
# landing on it. Either way the property the margin buys holds: "at least one
# full re-fire AND its cooldown have come and gone", and at 1320m both (1140m,
# 1260m) are strictly in the past. Kept as a formula so it tracks STALL
# automatically; the 22h it yields sits above 18h, which the table above
# STALL_THRESHOLD_SECONDS bounds at 11/232 = 4.7% of the healthy head-landed
# -> review distribution (p90 12.70h, max 30.81h). So a normally-queued PR no
# longer alarms, and that rests on a counted ceiling rather than on the one
# estimated cell in the table (which puts 22h at ~3% inside that band).
# Before BLO-34521 it was 330m, INSIDE the normal distribution -- and the 12h
# an earlier revision of this same fix yielded was still inside it: the same
# table brackets 12h between `> 18h` 4.7% and `> 8h` 19.4%, estimated ~11%.
ALARM_THRESHOLD_SECONDS = int(
    os.environ.get("ALARM_THRESHOLD_SECONDS") or (STALL_THRESHOLD_SECONDS + REFIRE_COOLDOWN_SECONDS + 2 * 60 * 60)
)

MARKER = "<!-- paperclip:review-request -->"

# Prefix for the reason recorded when a single PR could not be evaluated.
# sweep() isolates such failures so one bad PR cannot strand the rest; main()
# keys off this to report them rather than letting them read as clean skips.
SWEEP_ERROR_REASON_PREFIX = "skip: error"

# Prefix for the reason recorded when a PR was stranded and eligible but hit
# MAX_REFIRES_PER_RUN. Distinct from a clean skip so main() can report it.
DEFERRED_REASON_PREFIX = "skip: deferred"

# Prefix for the reason recorded when the pre-write re-read (BLO-31908) found
# a marker comment that was not there during the scan, so the cooldown no
# longer permits the write. Distinct from a clean skip because it is the one
# reason that is *evidence of a concurrent writer* -- rare by design, so worth
# being able to grep for if sweeps ever start overlapping routinely.
REREAD_SKIP_REASON_PREFIX = "skip: marker posted between scan and write"

# Prefix for the reason recorded when the pre-write re-read (BLO-32044) found
# that Ally produced a consolidated report for this exact head after the scan
# had already decided the PR was unreviewed. Held distinct from the cooldown
# prefix above because the two mean opposite things to an operator: that one
# says "somebody re-asked too recently", this one says "the review we were
# about to ask for has ALREADY LANDED" -- i.e. the sweep was about to spam a
# PR that is no longer stranded at all. Collapsing them would make the
# healthier outcome indistinguishable from evidence of a concurrent writer.
REVIEWED_SKIP_REASON_PREFIX = "skip: Ally reviewed this head between scan and write"

# Rate-limit exhaustion is recorded under SWEEP_ERROR_REASON_PREFIX (it IS a
# failure to evaluate, and must count as one for the degraded-run exit below),
# but carries this distinguishing token so main() can name the actual cause
# instead of reporting N indistinguishable per-PR errors.
RATE_LIMIT_TOKEN = "RateLimitExhausted"

# Distinguishing token for a failure in the WRITE pass rather than the read
# pass. Both are recorded under SWEEP_ERROR_REASON_PREFIX (both are genuine
# failures and must count toward sweep_is_degraded), but only a write failure
# means "this PR won a slot and the re-fire did not land" -- which is what
# lets main()'s deferred summary stay honest about where the budget went.
REFIRE_WRITE_FAILURE_TOKEN = "re-fire write failed"

# Distinguishing token for a failure of the PRE-WRITE RE-CHECK
# (refire_still_permitted), which is a third failure surface: it issues a live
# read of its own, after the budget is committed but before any write. Kept
# separate from REFIRE_WRITE_FAILURE_TOKEN because the operator question the
# two answer is different -- a write failure means the re-fire was attempted
# and did not land, while this means it was never attempted at all.
#
# Split the two halves of what that costs, because they go opposite ways and
# reading one for the other is how the deferral header fell behind its own
# ceiling. It leaves the DELIVERY cap (MAX_REFIRES_PER_RUN) free, since
# nothing was delivered -- but it SPENDS the ATTEMPT ceiling
# (MAX_REFIRE_ATTEMPTS_PER_RUN), because it made live reads and produced no
# write, which is exactly the shape that ceiling exists to bound. Contrast
# the WITHHELD branch, which spends neither. See the comment on the
# `recheck_failures += 1` site for the full argument.
#
# MUST NOT contain REFIRE_WRITE_FAILURE_TOKEN as a substring: main() classifies
# results by substring-matching these display strings (see the rate-limit
# exclusion below, and PEN-3417), so an overlapping token would silently
# re-classify every re-check failure as a failed write and inflate the
# "(N re-fire write(s) failed)" figure operators read.
REFIRE_RECHECK_FAILURE_TOKEN = "re-fire pre-write re-check failed"

# The write-pass failure tokens, as ONE set. Every member means "this PR WAS
# fully evaluated in the read pass -- its `pending_since` and therefore its
# alarm verdict are exact -- and only the write pass failed". Read-pass
# failures are what is left once these are excluded.
#
# Named as a set rather than spelled out at each use site because this same
# correction has now been made three times, each time by editing one call
# site and missing the others: `rate_limited` reported a fully-evaluated PR
# as one the run never reached (PEN-3417), then the DEGRADED paragraph
# reported it as one that "could not be read", then the section heading and
# the console line kept doing so after the paragraph was fixed. Each was the
# same defect at a different doorway. Deriving every bucket from this tuple
# means a token added here leaves all of them at once, so the next bucket
# cannot re-open the gap in whichever surface was not updated.
WRITE_PASS_FAILURE_TOKENS = (REFIRE_WRITE_FAILURE_TOKEN, REFIRE_RECHECK_FAILURE_TOKEN)


def is_write_pass_failure(reason):
    """True when `reason` names a failure the PR was fully evaluated before.

    Substring matching, like every other classifier here -- the tokens are
    display strings embedded in a human-readable reason. WRITE_PASS_FAILURE_TOKENS
    are required to be mutually non-overlapping (see REFIRE_RECHECK_FAILURE_TOKEN)
    so membership here cannot double-count.
    """
    text = str(reason)
    return any(token in text for token in WRITE_PASS_FAILURE_TOKENS)


def failure_breakdown(read_count, write_count, recheck_count):
    """Name every non-empty failure bucket, for the surfaces that report a total.

    Two surfaces report `len(failed)` as a single number -- the section
    heading and the console line -- and that number spans three kinds whose
    meaning to an operator is opposite: a read failure means a PR was never
    evaluated and the `alarming` count is an undercount, while the other two
    mean the PR was evaluated exactly and only the re-fire did not land.
    Reporting the total under one verb is what made the heading contradict
    the paragraph directly beneath it.

    The three buckets partition `failed` exactly -- `read_failures` is its
    complement with respect to WRITE_PASS_FAILURE_TOKENS, whose members are
    required to be mutually non-overlapping -- so the parts always sum to the
    total the caller prints beside them.
    """
    parts = []
    if read_count:
        parts.append("%d could not be read" % read_count)
    if write_count:
        parts.append("%d failed the re-fire write" % write_count)
    if recheck_count:
        parts.append("%d failed the pre-write re-check" % recheck_count)
    return ", ".join(parts)


def unserved_breakdown(write_count, recheck_count):
    """Name every non-empty bucket that won a slot and posted no marker.

    The deferred section's rotation guarantee is earned by
    REFIRE_COOLDOWN_SECONDS, which starts only when a marker is actually
    posted. Two buckets win a slot and post none: a re-fire whose WRITE
    failed, and one whose PRE-WRITE RE-CHECK failed (that branch `continue`s
    before `_refire_pr` is ever entered). For the rotation claim the two are
    indistinguishable -- both leave a longer-waiting PR unserved and
    uncooled, so both re-take the front of the next run ahead of everything
    deferred behind them.

    Kept separate from failure_breakdown because the question is different:
    that one partitions `failed` for an operator asking "what broke", this
    one names only the buckets that falsify the rotation guarantee. Read
    failures are deliberately absent -- a PR that could not be read never
    reached the budget, so it neither won a slot nor lost one.
    """
    parts = []
    if write_count:
        parts.append("%d re-fire write(s) failed" % write_count)
    if recheck_count:
        parts.append("%d pre-write re-check(s) failed" % recheck_count)
    return " and ".join(parts)


# Every API call is bounded. urlopen's default timeout is None -- block
# forever -- and this script never calls socket.setdefaulttimeout(), so a
# single stalled TCP connection would otherwise hang the job to the Actions
# 6-hour ceiling. With `concurrency.cancel-in-progress: false` every
# subsequent scheduled run then queues behind it: a multi-hour reconciler
# outage from one bad socket, on the job whose entire purpose is to not fail
# silently. The job-level `timeout-minutes` in the workflow is the outer
# bound; this is the inner one that lets a single slow call fail and the
# sweep continue.
REQUEST_TIMEOUT_SECONDS = int(os.environ.get("REQUEST_TIMEOUT_SECONDS") or 30)

# Exit codes. Both are non-zero (both turn the scheduled job red), but they
# are distinct so a red run can be read without opening the log: a stranded
# PR needs a human to go review it, whereas a degraded sweep means the
# reconciler could not complete its own work. Conflating them would mean
# "red because it worked and found something" and "red because it could not
# do its job" are the same signal -- which is the failure class this
# reconciler exists to remove.
#
# "Could not complete its work" covers two shapes, and main()'s summary names
# which one occurred rather than leaving the reader to assume the first:
# a READ failure, where the PR list is unknown and the alarm count is
# therefore unreliable; and a re-fire WRITE failure, where every PR was read
# (so the alarm count is exact) but re-fires the sweep decided on did not
# land. Both are genuine failures of the run; only the first blinds it.
EXIT_ALARM = 1
EXIT_SWEEP_DEGRADED = 2


class RateLimitExhausted(RuntimeError):
    """The token's request budget is spent, so every remaining call will fail.

    Raised instead of a bare HTTPError so sweep() can abort the loop rather
    than grinding out one identical failure per remaining PR: continuing
    cannot evaluate anything and only deepens the exhaustion.
    """


def _request(url, token, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", "Bearer %s" % token)
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read()
            return json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        if is_rate_limit_error(error):
            raise RateLimitExhausted(
                "GitHub API rate limit exhausted (HTTP %s) on %s" % (error.code, url)
            ) from error
        raise


def is_rate_limit_error(error):
    """True when an HTTPError is budget exhaustion rather than a real 403.

    A 403 is overloaded on this API: it is also "resource not accessible by
    integration", a permissions fault that retrying will never fix and that
    must NOT be reported as a rate limit. The discriminator is the header
    pair, not the status code -- `x-ratelimit-remaining: 0` (primary limit)
    or a `retry-after` on a 403/429 (secondary/abuse limit).
    """
    if getattr(error, "code", None) not in (403, 429):
        return False
    headers = getattr(error, "headers", None)
    if headers is None:
        return False
    remaining = headers.get("x-ratelimit-remaining")
    if remaining is not None and str(remaining).strip() == "0":
        return True
    return headers.get("retry-after") is not None


def _fetch_paginated(api_base_url, path, token):
    items = []
    page = 1
    while True:
        url = "%s%s%spage=%d&per_page=100" % (
            api_base_url.rstrip("/"),
            path,
            "&" if "?" in path else "?",
            page,
        )
        batch = _request(url, token)
        if not isinstance(batch, list):
            raise RuntimeError("GitHub API returned a non-array paginated payload for %s" % path)
        items.extend(batch)
        if len(batch) < 100:
            return items
        page += 1


def _parse_iso(value):
    # GitHub timestamps are `Z`-suffixed UTC; datetime.fromisoformat needs
    # `+00:00` before 3.11. Kept explicit rather than relying on the version
    # running in the workflow's Python.
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def first_pending_since(statuses, context=STATUS_CONTEXT):
    """Return the epoch seconds the head FIRST went `pending` for `context`,
    or None if the head is not currently pending for it.

    `statuses` is the `/repos/{o}/{r}/commits/{sha}/statuses` payload: every
    status ever posted for this immutable sha, newest first (GitHub's
    documented order for this endpoint). A head that has already resolved
    (success/failure) is not stranded -- only a head whose MOST RECENT status
    for the context is still `pending` is a candidate, and its stall age is
    measured from the OLDEST pending entry, not the newest: `review-gate.yml`
    reposts an identical `pending` status on every subsequent PR event
    (comments, labels, re-review requests), and each repost would otherwise
    reset the age to zero -- hiding the exact "funnel looks healthy but
    review never ran" symptom this script exists to catch.

    Deliberately walked in the API's own order rather than re-sorted by
    `created_at`: that field is only second-resolution, so an initial
    `pending` immediately followed by a resolution (success/failure) in the
    same second can tie. A stable sort on a tied key preserves the pre-sort
    relative order, which for a newest-first input leaves the tied pair in
    newest-first order even after an "ascending" sort -- so the entry taken
    as "last / newest" was actually the OLDER of the pair, inverting the
    resolved-vs-pending read for that head and misreporting an already
    -resolved head as freshly pending. Trusting the order GitHub already
    guarantees avoids re-deriving (and getting wrong) that ordering.
    """
    matching = [s for s in statuses if s.get("context") == context]
    if not matching:
        return None
    if matching[0].get("state") != "pending":
        return None
    # Walk forward (newest to oldest) and stop at the most recent non-pending
    # status: that boundary is where the CURRENT pending run started. A
    # resolved success/failure in between (e.g. a CHANGES_REQUESTED review
    # later dismissed) means an earlier pending interval already ended: only
    # the run since that resolution is a continuous wait. Using the
    # all-time-oldest pending entry instead would carry a stale interval's
    # age across the resolved boundary and could alarm immediately on a head
    # that only just went pending again.
    start = matching[0]
    for entry in matching[1:]:
        if entry.get("state") != "pending":
            break
        start = entry
    return _parse_iso(start["created_at"])


def marker_epochs_from_comments(comments):
    """`created_at` epochs of this PR's prior marker comments, any author.

    Pure. Shared by the scan and by the pre-write re-read (BLO-31908) so both
    derive the cooldown's input the same way -- the guard must see exactly
    what the decision saw, or it is guarding something else.
    """
    return [
        _parse_iso(c["created_at"])
        for c in comments
        if str(c.get("body") or "").startswith(MARKER)
    ]


def cooldown_blocks_refire(marker_epochs, now):
    """Pure: has a marker comment landed too recently to re-ask again?

    Factored out of should_refire so that the scan-time check and the
    pre-write re-read guard (refire_still_permitted) share ONE definition of
    the cooldown arithmetic. Two copies would be free to drift, and a guard
    that disagreed with the decision it guards would be worse than no guard.

    Returns (bool, str|None) -- whether the write is blocked, and the reason
    when it is.

    The reason is worded for the sign of `since_last`, which is NEGATIVE in
    exactly the case the pre-write guard exists for. `now` is sampled once at
    the top of the run and shared with should_refire, so a marker posted by a
    concurrent sweep mid-run is genuinely newer than this run's clock. The
    decision is right either way -- a negative `since_last` is still less than
    the cooldown, so the write is still blocked -- but rendering it as
    "re-asked -3s ago" reads as an arithmetic bug to anyone scanning the log,
    and that log line is the only evidence operators get that sweeps are
    overlapping. Name the skew instead of hiding it behind max(0, ...): the
    fact that the marker POSTDATES this run is the informative part.
    """
    if not marker_epochs:
        return False, None
    since_last = now - max(marker_epochs)
    if since_last < 0:
        return True, "re-asked %ds AFTER this run's scan clock (concurrent writer), cooldown %ds" % (
            int(-since_last), REFIRE_COOLDOWN_SECONDS,
        )
    if since_last < REFIRE_COOLDOWN_SECONDS:
        return True, "re-asked %ds ago < cooldown %ds" % (int(since_last), REFIRE_COOLDOWN_SECONDS)
    return False, None


def should_refire(pr, now):
    """Pure decision: does this PR need an automated re-ask right now?

    `pr` is a dict with:
      number                    int
      is_draft                  bool
      pending_since             float epoch seconds, or None
      existing_marker_epochs    list[float] -- created_at of prior
                                 `<!-- paperclip:review-request -->` comments
                                 on this PR (any author -- an operator's
                                 manual re-ask also counts against the
                                 cooldown, so the sweep never doubles up on
                                 one just posted by hand)

    Returns (bool, str) -- decision and a one-line reason, so `main` can log
    every PR it looked at rather than only the ones it acted on.
    """
    if pr["is_draft"]:
        return False, "draft"
    if pr["pending_since"] is None:
        # Mode-accurate wording: in `status-free` mode there is no pending
        # status to be "not currently" in, and an operator reading
        # "not currently pending" in a repo with no such check would go
        # looking for a signal that has never existed there.
        if PREDICATE_MODE == "status":
            return False, "not currently pending (reviewed, or never opened ready)"
        return False, "Ally has reviewed this head (or the head carries no usable date)"
    age = now - pr["pending_since"]
    if age < STALL_THRESHOLD_SECONDS:
        return False, "pending %ds < threshold %ds" % (int(age), STALL_THRESHOLD_SECONDS)
    blocked, cooled = cooldown_blocks_refire(pr["existing_marker_epochs"], now)
    if blocked:
        return False, cooled
    return True, "pending %ds >= threshold %ds" % (int(age), STALL_THRESHOLD_SECONDS)


def sweep_is_degraded(failed_count, considered_count):
    """Pure decision: did this run fail so widely that its "nothing alarming"
    verdict cannot be trusted?

    A per-PR failure is isolated so one bad PR cannot strand the rest -- but
    that isolation records the failure as `pending_since=None`, and
    `is_alarming` reads None as "not alarming". So without this check, a run
    where EVERY PR raised would print `alarming=0` and exit 0: a totally
    broken sweep and a healthy one produce the identical green tick. That is
    precisely the "silent failure that reads as health" defect this
    reconciler exists to eliminate, reintroduced in the reconciler itself.

    Keyed on a proportion rather than `failed_count > 0`, because one
    transient 5xx against one PR is normal and should not turn the schedule
    red for everyone. The floor of 3 keeps a short PR list from tripping on a
    single error (with 5 open PRs, 10% is 0.5, so one failure would otherwise
    read as "systematic").

    Ordering makes this matter more than the ratio suggests: GitHub returns
    `/pulls?state=open` newest-first, so when calls start failing partway
    through, the PRs dropped are the OLDEST -- exactly the population most
    likely to be stranded, and the population this alarm exists for.
    """
    if failed_count <= 0:
        return False
    return failed_count >= max(3, 0.1 * considered_count)


def is_alarming(pr, now):
    """Pure decision: has this head been pending long enough that an
    automated re-fire should already have resolved it -- i.e. is silent
    re-firing no longer an adequate response and a human needs to look?

    Same `pr` shape as `should_refire`. Deliberately independent of whether a
    re-fire happened this run: a PR that was re-fired 3 hours ago and is
    STILL pending is exactly the case this must catch, not suppress.
    """
    if pr["is_draft"] or pr["pending_since"] is None:
        return False
    return (now - pr["pending_since"]) >= ALARM_THRESHOLD_SECONDS


def ally_has_reviewed_head(reviews, comments, head_sha, ally_logins):
    """True if Ally has already produced a consolidated review report for this
    exact head, on either surface -- a formal review or a `## Ally` comment.

    This is the two-surface check review feedback on #1383 flagged as
    missing: `review/ally-complete` is deliberately left `pending` by
    require-ally-review.py's decide() in cases that are NOT a lost wake --
    a clean self-review on an App-authored PR (self_review_signal, always
    "pending", waiting on a distinct human) or a clean-commented review on
    someone else's PR (CLEAN_COMMENTED_STATUS, waiting on the override
    label). Both mean Ally reviewed the head; re-firing a review request on
    top of that is spam, and eventually a false alarm, not reconciliation.
    Only a `pending` status with NO Ally signal on either surface -- decide()
    falls through to `signal is None` -- is the genuine lost-wake case this
    sweep exists to catch.

    Deliberately coarser than decide()'s full state machine: any consolidated
    Ally report attesting this head counts, regardless of which branch decide()
    would route it through.

    But coarser must not mean *weaker*. An earlier revision of this docstring
    argued that erring toward "Ally reviewed" is the safe direction because it
    only makes the sweep less likely to re-fire. That is backwards, and
    native-codex flagged it on #1383: a false "reviewed" SUPPRESSES the
    recovery this sweep exists to provide, leaving `review/ally-complete`
    pending forever with no re-fire and no alarm -- reinstating the exact
    BLO-22892 defect. A false "not reviewed" merely costs one redundant review
    request. So the bias runs the other way: require positive evidence that the
    consolidated review artifact was actually produced.

    Both surfaces therefore demand the same predicate --
    is_consolidated_ally_comment_for_head, i.e. the `## Ally ...
    Consolidated PR Review` envelope AND an exact head attestation. A bare
    `Reviewed head: <sha>` line is not enough on either surface: any malformed
    or incidental Bot review that happened to carry one would otherwise
    permanently suppress recovery. (The predicate is a pure body-shape test,
    so it applies to a formal review body exactly as it does to a comment;
    real Ally reviews carry that envelope on both surfaces.)

    Three things are deliberately NOT treated as positive evidence, per review
    feedback on #1383:

    - A bare head attestation with no consolidated envelope, per the above.

    - `review.commit_id`. It is MUTABLE -- require-ally-review.py's own
      `positively_bound` comment documents an observed case (frr#29) where an
      approval submitted against one head later reported `commit_id` equal to
      a DIFFERENT, later head it never actually reviewed (a revert made the
      trees identical). Trusting it here could make a genuinely-unreviewed
      head that happens to match an old commit_id read as serviced forever.
      Only the immutable body evidence counts -- the consolidated envelope
      plus an exact "Reviewed head: <sha>" line (`attests_head`).
    - A login match alone. `ally_logins` intentionally also matches the
      `allyblockcast` maintainer *User* account -- a distinct, trusted human
      identity for require-ally-review.py's own distinct-reviewer purposes
      (see its `distinct_reviewer_signals_for_head`). A human posting under
      that login is not the automated Ally App this sweep is checking
      whether the wake ever reached, so both loops below also require
      `user.type == "Bot"` -- the App/Bot identity, not any account sharing
      one of the configured login strings.
    """
    ally = set(ally_logins)
    for review in reviews:
        user = review.get("user") or {}
        login = user.get("login")
        if not isinstance(login, str) or login not in ally or user.get("type") != "Bot":
            continue
        if review.get("state") == "DISMISSED":
            continue
        body = str(review.get("body") or "")
        if is_consolidated_ally_comment_for_head(body, head_sha):
            return True
    for comment in comments:
        user = comment.get("user") or {}
        login = user.get("login")
        if not isinstance(login, str) or login not in ally or user.get("type") != "Bot":
            continue
        body = str(comment.get("body") or "")
        if is_consolidated_ally_comment_for_head(body, head_sha):
            return True
    return False


def build_comment_body(pr_number, head_sha, age_seconds, requested_login=None, mode=None,
                       request_pending=False):
    """The durable audit trail for a re-fire, and the cooldown input.

    The opening sentence is mode-aware on purpose. In `status-free` mode there
    is no `review/ally-complete` check on the repo at all, so the original
    wording ("this PR's `review/ally-complete` check has been `pending`")
    would assert a signal that does not exist -- misleading anyone who then
    goes looking for it on the Checks tab.

    `request_pending` renders the line for the case where the review request
    has NOT been issued yet, which is the live ordering in _refire_pr: the
    marker is posted first so it exists even if a later call fails (PEN-3394
    review). The two outcome-asserting variants are kept for callers that
    already know the result. Do not collapse the three -- a body that claims
    an outcome it was written before is exactly the false audit trail this
    comment is supposed to be evidence against.
    """
    hours = age_seconds / 3600.0
    mode = mode or PREDICATE_MODE
    if request_pending:
        request_line = (
            "Requesting a review from @%s directly (native GitHub review request, not "
            "just this comment) against current head `%s`. This comment is posted FIRST, "
            "before that request, so the re-fire cooldown is recorded even if the request "
            "call fails -- see the sweep job's Actions log for its outcome.\n"
            % (ALLY_REQUEST_REVIEWER_LOGIN, head_sha[:7])
        )
    elif requested_login:
        request_line = (
            "Requested a review from @%s directly (native GitHub review request, "
            "not just this comment) against current head `%s`.\n" % (requested_login, head_sha[:7])
        )
    else:
        request_line = (
            "Attempted to request a review from @%s directly; that call failed, so this "
            "comment is the only re-fire for now -- see the sweep job's Actions log.\n"
            % ALLY_REQUEST_REVIEWER_LOGIN
        )
    if mode == "status":
        condition = "this PR's `%s` check has been `pending` for %.1fh" % (STATUS_CONTEXT, hours)
    else:
        condition = "head `%s` has been awaiting review for %.1fh" % (head_sha[:7], hours)
    return (
        "%s\n"
        "@ally %s with no review on either surface (`pulls/%d/reviews` carries no "
        "consolidated report for this head, no `## Ally` comment either) -- automated "
        "sweep (BLO-22892 / BLO-28203), not a human/agent re-ask.\n\n"
        "%s"
    ) % (MARKER, condition, pr_number, request_line)


def reviewer_is_already_requested(pr_payload, login=ALLY_REQUEST_REVIEWER_LOGIN):
    """True when `login` is already an active requested reviewer on this PR.

    Pure so it can be tested without the network. Logins are compared
    case-insensitively because GitHub preserves the case a login was created
    with but treats it case-insensitively everywhere else.
    """
    requested = (pr_payload or {}).get("requested_reviewers") or []
    target = (login or "").lower()
    return any((entry or {}).get("login", "").lower() == target for entry in requested)


def refire_still_permitted(owner, repo, number, head_sha, token, api_base_url, now):
    """Re-read this PR's state and re-apply BOTH scan-time preconditions, as
    late as possible before the write. Returns (bool, str|None, str|None) --
    permitted, the reason when it is not, and the reason-prefix naming which
    precondition declined so main() can report the two separately.

    WHY (BLO-31908). The cooldown is derived from GitHub state
    (`existing_marker_epochs`) rather than run-local state, which is the right
    choice: it survives a restart and it counts an operator's manual re-ask
    too. But the read happens during the scan and the write happens here, so
    the check is check-then-act, not atomic. Two sweeps executing concurrently
    can both observe `since_last >= REFIRE_COOLDOWN_SECONDS` and both fire.

    That is worse than a duplicate comment. request_review deliberately
    DELETEs before it POSTs (see its docstring -- a bare POST no-ops against an
    existing request), so the interleaving `A-DELETE / A-POST / B-DELETE /
    B-POST` both multiplies reviewer wakes AND leaves a window in which the PR
    has no pending review request at all.

    Concurrent sweeps are not the normal case -- cadence is hourly, a healthy
    run takes ~2min, and the cooldown is 2h -- but review-gate-sweep.yml
    deliberately carries no `concurrency` group (BLO-31818), because the group
    could only ever discard a starved backlog rather than serialise it. So a
    starvation window released all at once does run sweeps together.

    ALSO (BLO-32044). The cooldown is not the scan's only precondition, and it
    was originally the only one re-applied here. _consider_pr also skips a PR
    when ally_has_reviewed_head() is true, and that read is just as stale by
    the time we reach the write. The uncovered interleaving needs no concurrent
    sweep at all -- one run whose scan and write straddle Ally answering is
    enough:

      1. scan reads the surfaces; Ally has not reviewed head -> candidate
      2. Ally posts its consolidated report (comment, or a formal review)
      3. the guard re-reads -- the fresh report IS in the list
      4. without this check, the sweep re-asks for a review that just landed

    That is the stacked-marker-request pathology this script exists to avoid,
    arriving through the front door. Measured request->response latency is
    5m-74m, so a ~2min run straddling it is small but not exotic.

    Both surfaces are consulted, because either alone yields false negatives:
    verified live 2026-08-04, `#952` carried 4 comment-shaped reviews with an
    EMPTY `pulls/952/reviews`, while `#937` carried 4 formal review objects and
    no comment-shaped one.

    ORDERING. Two axes, and they pull against each other:

    - By VERDICT QUALITY, which wins: BOTH answered checks run before the
      cooldown. When an answered check and the cooldown both fire, they
      disagree about what the PR *is*: the cooldown says "someone re-asked
      recently" (contended -- keep pending_since, may alarm) and an answered
      check says "Ally answered THIS head" (answered -- not stranded at all).
      Both withhold the write, so write suppression is unaffected either way;
      what differs is that cooldown-first returns REREAD_SKIP_REASON_PREFIX,
      so _consider_pr takes the contended branch, keeps pending_since, and an
      answered PR alarms and is filed under "contended" in the step summary --
      pointing an operator at a concurrency problem on a PR that is simply
      answered. Answered is both the more specific and the more accurate fact,
      so it wins on BOTH surfaces. Pinned by
      test_a_compound_skip_reports_answered_not_contended and
      test_a_reviews_surface_compound_skip_reports_answered_not_contended;
      nothing else does.
    - By COST, applied only *within* the answered checks: the comment surface
      is free (the comments are already in hand) and runs first, so it
      short-circuits the one paid read. Putting the reviews read ahead of the
      cooldown means the cooldown-blocked path now pays that request too --
      but that path is, by construction, the rare one. should_refire already
      applied the cooldown at scan time, so for it to block again here a
      marker must have landed in the scan->write gap: a concurrent sweep or a
      hand re-ask, which is the very race this guard exists for. The cost is
      bounded by that set -- NOT by MAX_REFIRES_PER_RUN, because a write this
      guard withholds leaves its budget slot free (see sweep()) -- against a
      1,000/hour budget. The cost is not only the request: the reorder also
      moves the cooldown-blocked path from cannot-fail to can-fail, since it
      now issues a fetch before returning where it previously returned first.
      A raise there propagates to sweep(), is isolated per-PR, and counts
      toward sweep_is_degraded (failed >= max(3, 0.1 * considered)). Accepted:
      it fails closed (withhold and say so, per "Failure is NOT swallowed"
      below), needs three failures to trip the alarm, and rides a path that is
      rare by construction.

    Why the reviews surface is not the cheap half to skip: across the 45 most
    recent PRs in this repo, ZERO Ally consolidated reports landed on the
    comment surface -- every one was on the reviews surface. The zero is the
    load-bearing figure and is what the ordering rests on; the matching
    numerator is a moving target and is quoted only as provenance (34 reports /
    57 reviews-surface on 2026-09-20, independently re-measured as 37 / 62 over
    the same window a day later). A future reader finding a different numerator
    is seeing drift, not a measurement error -- re-check the zero, not the
    count. An earlier revision of this docstring asserted the opposite -- that
    the comment surface was the one Ally most often answers on -- and used it
    to justify leaving the reviews half unfixed. That claim was never measured
    and is wrong: leaving it out addressed the surface responsible for none of
    the observed answers. Both surfaces are still checked, because neither is
    sufficient alone (verified live 2026-08-04: #952 had 4 comment-shaped
    reviews and an EMPTY pulls/952/reviews, #937 the reverse).

    The check is deliberately head-exact, not "has Ally reviewed at all".
    ally_has_reviewed_head demands a consolidated report attesting THIS head,
    so a report against a superseded head does not block -- reconciling that
    case is precisely what the sweep exists for, and a coarser test here would
    silently disable the reconciler while still passing the two tests above.

    RESIDUAL, stated rather than claimed away: this NARROWS the window from the
    whole scan (minutes -- one request per open PR) to the gap between this
    re-read and the POST (~a second). It does NOT close it. There is no
    compare-and-set on the GitHub comment API, so a second run entering after
    this re-read and before the write still fires, and the DELETE/POST
    interleaving above is still reachable. The exposure is small, not absent;
    do not read this guard as making overlapping writes safe. BLO-32044 narrows
    a DIFFERENT window with the same mechanism and inherits the same residual;
    it does not close the concurrent-sweep race either.

    `now` is the run's single scan-time clock, shared with should_refire rather
    than re-sampled here. It lags real time by at most the run duration (~2min
    against a 2h cooldown), and it lags in the SAFE direction: an older `now`
    makes `since_last` smaller, so the guard blocks more readily, never less.

    Failure is NOT swallowed the way request_review's is. A re-read that raises
    propagates to sweep(), which isolates it per-PR and reports it. That is
    deliberate: when the guard cannot be evaluated, the safe direction is to
    withhold the write and say so, not to write blind.
    """
    comments = _fetch_paginated(
        api_base_url, "/repos/%s/%s/issues/%d/comments" % (owner, repo, number), token
    )
    # BOTH answered checks run before the cooldown (see ORDERING above):
    # answered must win over contended, because cooldown-first sends an
    # answered PR down the contended branch, which keeps pending_since and
    # alarms. Free before paid within that: the comments are already fetched
    # immediately above, so this check costs nothing by construction. Passing
    # [] for reviews is a genuine single-surface test: ally_has_reviewed_head
    # scans the two lists independently.
    if ally_has_reviewed_head([], comments, head_sha, ALLY_REVIEWER_LOGINS):
        return False, "consolidated report on the comment surface", REVIEWED_SKIP_REASON_PREFIX
    reviews = _fetch_paginated(
        api_base_url, "/repos/%s/%s/pulls/%d/reviews" % (owner, repo, number), token
    )
    if ally_has_reviewed_head(reviews, [], head_sha, ALLY_REVIEWER_LOGINS):
        return False, "consolidated report on the reviews surface", REVIEWED_SKIP_REASON_PREFIX
    blocked, reason = cooldown_blocks_refire(marker_epochs_from_comments(comments), now)
    if blocked:
        return False, reason, REREAD_SKIP_REASON_PREFIX
    return True, None, None


def request_review(owner, repo, number, token, api_base_url, login=ALLY_REQUEST_REVIEWER_LOGIN):
    """Fire a native review request (`pull_request.review_requested`) rather
    than relying on the marker comment alone. See ALLY_REQUEST_REVIEWER_LOGIN
    above for why: this is the mechanism BLO-22892 confirmed actually
    re-arms a lost wake, not the `issue_comment` marker.

    A bare POST is NOT sufficient, and assuming it was is what let this
    sweep report success while delivering nothing. Measured against the live
    API on 2026-08-14 (BLO-22892, PR #1383): POSTing a login that is already
    an active requested reviewer returns **HTTP 200**, not 422 -- and creates
    no `review_requested` timeline event, therefore no webhook, therefore no
    reviewer wake. That is precisely the stranded shape this sweep exists to
    clear: a `COMMENTED` review does not clear a review request, so any PR
    Ally has commented on but not approved keeps the request outstanding
    forever, and every subsequent re-fire silently no-ops.

    So withdraw an existing request before re-issuing it. DELETE + POST does
    produce a fresh `review_requested` event (verified on #1383 at
    2026-08-14T17:38:43Z, after a bare POST at 17:36Z produced none).

    Failures are swallowed and logged rather than raised: the marker comment
    in sweep() still leaves a durable, human-visible trail either way. That
    contract covers *transport* failures too, not just HTTP status codes --
    `urllib.error.HTTPError` is a subclass of `URLError`, so catching only the
    former lets a DNS/timeout/connection-reset failure escape into sweep() and
    abort the whole run before the fallback comment is ever posted. Catch
    `OSError`, the common ancestor of both (and of a bare socket timeout
    raised during the response read).
    """
    endpoint = "%s/repos/%s/%s/pulls/%d/requested_reviewers" % (api_base_url.rstrip("/"), owner, repo, number)
    withdrawn = False
    try:
        pr_payload = _request("%s/repos/%s/%s/pulls/%d" % (api_base_url.rstrip("/"), owner, repo, number), token)
        if reviewer_is_already_requested(pr_payload, login):
            _request(endpoint, token, method="DELETE", payload={"reviewers": [login]})
            withdrawn = True
        _request(endpoint, token, method="POST", payload={"reviewers": [login]})
        return True
    except OSError as error:
        # A failure after the withdraw leaves the PR with no pending request
        # at all. Say so loudly: it is strictly worse than the state we found
        # and a human re-request is the recovery.
        detail = getattr(error, "code", None) or getattr(error, "reason", None) or error
        print(
            "PR #%d: native review request to %s failed (%s)%s, falling back to marker comment only"
            % (
                number,
                login,
                detail,
                " AFTER withdrawing the existing request -- PR now has no pending reviewer request" if withdrawn else "",
            ),
            file=sys.stderr,
        )
        return False


def unreviewed_since(pr_payload, head_commit_payload, now=None):
    """Epoch seconds from which this head has been awaiting review, for
    `status-free` mode. Pure -- the caller does the two fetches.

    There is no `pending` status to date the wait from in this mode, so it is
    dated from when the head could FIRST have been reviewed, which is the
    later of two events:

      - the PR opening (a review cannot be owed on a branch nobody has
        proposed yet), and
      - the head commit landing (a review cannot be owed on a revision that
        did not exist yet).

    Taking the max is what makes the measure correct in both directions. Using
    the commit date alone would date a long-lived branch's wait from whenever
    its tip was authored -- possibly weeks before the PR opened -- and alarm
    instantly on a PR opened five minutes ago. Using the PR creation date
    alone would never advance when a stale PR is force-pushed, so a fresh
    revision would inherit the old revision's accumulated age and be re-fired
    immediately, ignoring the cooldown's intent.

    Each candidate is clamped to `now` before the max. `commit.committer.date`
    is client-settable and carries no guarantee of being in the past: a
    skewed clock or a rewritten date yields a FUTURE timestamp, hence a
    negative age, which can never reach STALL_THRESHOLD_SECONDS *or*
    ALARM_THRESHOLD_SECONDS -- the PR would become permanently invisible to
    both the re-fire and the alarm. That is the suppression direction this
    module's predicate bias explicitly refuses: a false "not awaiting review"
    hides a stranded PR forever, while a false "awaiting review" costs one
    redundant request. Clamping makes a future-dated head start its clock at
    `now` and become eligible normally.

    Returns None if neither timestamp can be parsed, which the caller treats
    as "not awaiting review" -- fail closed toward not spamming.
    """
    now = now if now is not None else time.time()
    candidates = []
    created_at = (pr_payload or {}).get("created_at")
    if created_at:
        try:
            candidates.append(min(_parse_iso(created_at), now))
        except (ValueError, TypeError):
            pass
    commit = (head_commit_payload or {}).get("commit") or {}
    committer_date = (commit.get("committer") or {}).get("date")
    if committer_date:
        try:
            candidates.append(min(_parse_iso(committer_date), now))
        except (ValueError, TypeError):
            pass
    return max(candidates) if candidates else None


def too_young_to_be_stranded(pr_payload, now):
    """True when the PR list payload ALONE proves this PR cannot be stranded,
    so none of its per-PR fetches need to be issued.

    Call volume is the binding constraint on this job, not correctness: in
    `status-free` mode every non-draft PR costs at least three requests (head
    commit + comments page + reviews page), and this repo's open-PR backlog
    puts that in the hundreds per run against `github.token`'s documented
    budget of 1,000/hour/repository -- shared with every other workflow here,
    so at the half-hourly `9,39 * * * *` cadence this paragraph was written
    against, exhaustion would have been the steady state rather than an edge
    case. That is why review-gate-sweep.yml now runs hourly.

    The measured figures live THERE, in one dated snapshot: requests per run,
    and what this cut is currently worth. Note the table splits it in two --
    this function is STAGE 1, saving all 3 requests on the PRs it proves
    young from `created_at` alone; `_consider_pr`'s post-head-fetch early
    return is stage 2, saving the remaining 2 on the PRs only
    `committer_date` proves young. Quoting either stage as the whole cut gets
    the saving wrong in one direction or the other. Deliberately not copied
    here -- the second copy is the thing that drifts, and that file's own
    rule is `re-measure the whole table or none of it`.

    The cheap proof: `unreviewed_since` returns `max(created_at,
    committer_date)` (each clamped to `now`), so `pending_since >=
    created_at` always. Therefore `now - pending_since <= now - created_at`,
    and a PR younger than STALL_THRESHOLD_SECONDS cannot clear the stall
    threshold, let alone the strictly larger alarm threshold. No fetch can
    change that verdict.

    Deliberately restricted to `status-free` mode. In `status` mode
    `pending_since` comes from a commit status, which is not bounded below by
    the PR's creation date, so the same inequality does not hold and the
    filter would be unsound.
    """
    if PREDICATE_MODE == "status":
        return False
    created_at = (pr_payload or {}).get("created_at")
    if not created_at:
        return False
    try:
        created = _parse_iso(created_at)
    except (ValueError, TypeError):
        return False
    return (now - created) < STALL_THRESHOLD_SECONDS


def _consider_pr(owner, repo, pr, token, api_base_url, now):
    """Evaluate one open PR and report whether it is stranded and eligible
    for a re-ask. Returns the result tuple for the accounting. Network
    failures propagate to sweep(), which isolates them per-PR.

    Issues NO writes, deliberately. Which of the eligible PRs actually get
    the run's MAX_REFIRES_PER_RUN budget cannot be decided while walking the
    list, because it depends on how every OTHER PR came out -- see the
    ranking note in sweep(). Writing here is what made the budget
    first-come-first-served over an order nobody chose.

    Every PR is still fully evaluated whether or not it will win a slot, so
    a PR that loses one still counts toward `considered` and can still ALARM.
    Skipping evaluation instead would hide a stranded PR behind the cap,
    which is the silent cap this must not be.

    A re-fire decision made here is PROVISIONAL. The scan's reads are minutes
    stale by the time a write is issued, so BOTH of this pass's preconditions
    are re-applied immediately before that write by refire_still_permitted():
    a concurrent sweep may have re-asked (BLO-31908) and Ally may have
    answered (BLO-32044). That re-check lives in sweep()'s pass 2 rather than
    here, because this pass issues no writes -- which is also what keeps a
    budget-deferred PR and a dry run from paying for its extra read.
    """
    number = pr["number"]
    is_draft = bool(pr.get("draft"))
    head_sha = pr["head"]["sha"]
    pending_since = None
    marker_epochs = []
    if not is_draft and too_young_to_be_stranded(pr, now):
        # Proven not stranded from the list payload alone -- see
        # too_young_to_be_stranded. Reported rather than dropped, so the
        # accounting still names every PR the sweep looked at.
        age = int(now - _parse_iso(pr["created_at"]))
        return (pr, head_sha, None, False, "skip: opened %ds ago < threshold %ds" % (age, STALL_THRESHOLD_SECONDS))
    if not is_draft:
        if PREDICATE_MODE == "status":
            statuses = _fetch_paginated(
                api_base_url, "/repos/%s/%s/commits/%s/statuses" % (owner, repo, head_sha), token
            )
            pending_since = first_pending_since(statuses)
        else:
            # status-free: the wait is dated from the head itself, and the
            # ONLY thing that ends it is a real Ally report at this exact
            # head -- checked below, identically to status mode.
            head_commit = _request(
                "%s/repos/%s/%s/commits/%s" % (api_base_url.rstrip("/"), owner, repo, head_sha), token
            )
            pending_since = unreviewed_since(pr, head_commit, now=now)
        if pending_since is not None and (now - pending_since) < STALL_THRESHOLD_SECONDS:
            # Below the stall threshold, so should_refire is False and
            # is_alarming is False (its threshold is strictly larger) no
            # matter what the review surfaces say. The two paginated fetches
            # below cannot change the verdict, only the wording of the
            # reason, so they are not worth ~2 requests per young head
            # against a 1,000/hour budget. This is the same argument as
            # too_young_to_be_stranded, applied one step later where the
            # real `pending_since` is known -- and unlike that filter it is
            # sound in BOTH modes, because it tests the computed value
            # rather than a lower bound on it.
            return (
                pr, head_sha, pending_since, False,
                "pending %ds < threshold %ds" % (int(now - pending_since), STALL_THRESHOLD_SECONDS),
            )
        if pending_since is not None:
            comments = _fetch_paginated(
                api_base_url, "/repos/%s/%s/issues/%d/comments" % (owner, repo, number), token
            )
            reviews = _fetch_paginated(
                api_base_url, "/repos/%s/%s/pulls/%d/reviews" % (owner, repo, number), token
            )
            if ally_has_reviewed_head(reviews, comments, head_sha, ALLY_REVIEWER_LOGINS):
                # Ally already produced a signal for this exact head on one of
                # the two surfaces. In `status` mode the status is
                # legitimately `pending` on a distinct-approval/override wait,
                # not a lost wake; in `status-free` mode this is the whole
                # test. Either way treat as not-pending so should_refire /
                # is_alarming both skip it.
                pending_since = None
            else:
                marker_epochs = marker_epochs_from_comments(comments)
    decision_input = {
        "number": number,
        "is_draft": is_draft,
        "pending_since": pending_since,
        "existing_marker_epochs": marker_epochs,
    }
    refire, reason = should_refire(decision_input, now)
    return (pr, head_sha, pending_since, refire, reason)


def _refire_pr(owner, repo, pr, head_sha, pending_since, token, api_base_url, now):
    """Issue the writes for one stranded PR: the marker comment and the native
    reviewer re-request, in that order. Two write STEPS, but up to three write
    REQUESTS -- request_review withdraws an existing request before re-issuing
    it, so it is itself a GET plus a conditional DELETE plus a POST (see its
    docstring, and the budget note at MAX_REFIRE_ATTEMPTS_PER_RUN).

    Split out of _consider_pr so the decision pass can rank every eligible PR
    before any of them is written (see sweep()). Exceptions propagate to the
    caller, which isolates them per-PR exactly as the decision pass does.

    ORDER IS LOAD-BEARING: the marker comment is posted BEFORE the review
    request, and must stay that way (PEN-3394 review). The marker is the
    cooldown's ONLY token, and request_review swallows its own failures
    (returning a bool) while the comment POST raises. Under the old order --
    request first, comment second -- a comment that raised left a wake already
    delivered and no token to throttle the next one: `succeeded` is not
    incremented, `cooldown_blocks_refire` stays False, `pending_since` has not
    moved, and under longest-wait ranking the PR is still rank 0, so the next
    hourly run serves it first and wakes Ally again. Forever, while
    `unserved_breakdown` reports it to the operator as NOT served. GitHub's
    secondary content-creation limit is the realistic trigger, and this loop
    invites it by POSTing up to MAX_REFIRES_PER_RUN comments back-to-back.

    Posting the token first makes a failed comment cost a SKIPPED re-fire
    rather than an unthrottled one -- the safe direction, and the one
    request_review's "the marker still leaves a durable trail" contract
    already assumes. The body is built with request_pending=True because at
    that point the request outcome genuinely is not known yet; do not "restore"
    an outcome-asserting body here without moving the write back, which would
    reintroduce the storm.
    """
    body = build_comment_body(
        pr["number"], head_sha, now - pending_since,
        mode=PREDICATE_MODE,
        request_pending=True,
    )
    _request(
        "%s/repos/%s/%s/issues/%d/comments" % (api_base_url.rstrip("/"), owner, repo, pr["number"]),
        token,
        method="POST",
        payload={"body": body},
    )
    request_review(owner, repo, pr["number"], token, api_base_url)


def sweep(owner, repo, token, api_base_url, now=None, dry_run=False):
    """List open PRs, decide, and re-fire. Returns the list of (pr, reason)
    for every non-draft open PR considered, in list order, so the caller can
    print a full accounting -- not just the ones actioned (no silent caps).

    Two passes, and the split is load-bearing rather than tidiness (PEN-3394):

      1. DECIDE every PR. No writes.
      2. Spend MAX_REFIRES_PER_RUN on the LONGEST-WAITING eligible PRs.
         The cap counts DELIVERED re-fires; see MAX_REFIRE_ATTEMPTS_PER_RUN.

    This used to be one pass that wrote as it walked, which handed the budget
    to whatever order the API returned -- and `GET /pulls?state=open` returns
    NEWEST FIRST. (That ordering is already noted in main()'s degraded-run
    summary below; it was reasoned about for the dropped-reads path and not
    for this one.) With more eligible PRs per run than slots, the budget was
    therefore always spent on the newest and the oldest never got a slot at
    all. Measured on this repo 2026-09-20 over five consecutive runs: in every
    one, every re-fired PR number was strictly greater than every deferred
    number -- a deterministic rank cut, not a distribution. #1862 went 50h
    with no re-fire while newer PRs were re-fired hourly, and the deferred
    summary below was telling operators they "will be picked up on the next
    scheduled run" when structurally they would not be.

    Ranking by `pending_since` ascending -- longest wait first -- is what
    makes the cap fair rather than positional. Note the cap alone does NOT
    starve anyone: REFIRE_COOLDOWN_SECONDS takes a PR out of eligibility for
    2h as soon as it is served, so a stable candidate set rotates through the
    budget on its own. Newest-first defeated that only because new PRs keep
    arriving and keep refilling the front of the list. Ordering by wait also
    avoids the mirror-image bug that plain oldest-PR-first would introduce: a
    brand-new PR whose `pull_request.opened` wake was LOST -- precisely what
    this reconciler exists to backstop -- would sit behind the entire old
    cohort. Wait-time ordering serves it on the same terms as everyone else.

    Pass 1 costs no extra API calls: every PR was already fully evaluated
    before this change (that is why over-budget PRs could still ALARM), so
    only the *timing* of the two writes moves.

    Each PR is evaluated in isolation, and so is each write. A failure
    against one PR must never strand the others: this sweep *is* the
    reconciler for stranded PRs, so letting a single transient error abort
    the loop would reinstate exactly the defect it exists to clear
    (BLO-22892) -- and silently, since the remaining PRs would simply never
    be considered.

    `dry_run` evaluates every PR and reports what it WOULD do without issuing
    either write (the reviewer re-request or the marker comment). It exists so
    the before/after predicate counts required by BLO-28203's verifying signal
    can be captured from a real repo without mutating it.
    """
    now = now if now is not None else time.time()
    prs = _fetch_paginated(api_base_url, "/repos/%s/%s/pulls?state=open" % (owner, repo), token)
    results = []
    for index, pr in enumerate(prs):
        head_sha = pr.get("head", {}).get("sha", "")
        if pr.get("locked"):
            # A locked conversation is a deliberate operator signal to stop
            # automated chatter on this PR. Both actions this sweep can take
            # -- a reviewer re-request and a marker comment -- are precisely
            # that chatter, so skip before any status read or write. (Intent,
            # not permissions: a write-access token can still comment on a
            # locked PR.)
            results.append((pr, head_sha, None, False, "skip: conversation locked"))
            continue
        try:
            results.append(_consider_pr(owner, repo, pr, token, api_base_url, now))
        except RateLimitExhausted as error:
            # Not isolated per-PR like the errors below: the budget is spent,
            # so every remaining PR would raise the identical error. Grinding
            # through them would deepen the exhaustion, hide the real cause
            # behind N indistinguishable per-PR failures, and delay the run's
            # end for no information. Abort the READS, but keep the partial
            # results and record the unevaluated remainder as failures -- they
            # feed sweep_is_degraded, so this run exits non-zero rather than
            # reporting `alarming=0` off a list it never finished reading.
            print("rate limit exhausted at PR #%d: %s" % (pr.get("number", -1), error), file=sys.stderr)
            for unevaluated in prs[index:]:
                results.append((
                    unevaluated,
                    unevaluated.get("head", {}).get("sha", ""),
                    None,
                    False,
                    "%s -- %s" % (SWEEP_ERROR_REASON_PREFIX, RATE_LIMIT_TOKEN),
                ))
            # Fall through to the re-fire pass rather than returning. Two
            # reasons, and the second is the one that makes `break` load-
            # bearing rather than merely preferable:
            #
            #   1. Under the old single pass, PRs walked before exhaustion
            #      had ALREADY been written; returning here would make an
            #      exhausted run issue zero re-fires, which is a regression --
            #      the re-asks are the point of the job and the reads only
            #      serve them.
            #   2. Since the writes no longer happen inside _consider_pr, a
            #      `return` would leave the already-decided PRs at
            #      refire=True with no write ever attempted -- and main()
            #      derives `refired = [r for r in results if r[3]]`, so the
            #      run would REPORT re-fires that never happened. That is a
            #      correctness defect in the accounting, not just lost work.
            #
            # Do not "simplify" this back to a return. Pinned by
            # test_rate_limit_in_the_read_pass_still_spends_the_refire_budget.
            # The writes are attempted and may themselves hit the limit,
            # which lands in the per-write isolation below.
            break
        except Exception as error:  # noqa: BLE001 -- deliberate per-PR isolation
            print(
                "PR #%d: sweep failed (%s: %s) -- continuing with the remaining PRs"
                % (pr.get("number", -1), type(error).__name__, error),
                file=sys.stderr,
            )
            results.append((pr, head_sha, None, False, "%s -- %s" % (SWEEP_ERROR_REASON_PREFIX, type(error).__name__)))

    # --- Pass 2: spend the budget, longest wait first. ---------------------
    #
    # `refire` True implies `pending_since` is not None (should_refire returns
    # False for None before it can reach the eligible branch), so the sort key
    # is always a real epoch. Ties keep list order, which is stable and
    # arbitrary -- two PRs stalled in the same second have no fairness claim
    # against each other.
    eligible = sorted(
        (i for i, outcome in enumerate(results) if outcome[3]),
        key=lambda i: results[i][2],
    )
    #
    # The cap counts DELIVERED re-fires, not attempts, and that distinction is
    # load-bearing (PEN-3394 review). A failed write posts no marker, so
    # should_refire's cooldown never engages -- the PR keeps the longest wait
    # and sorts back to rank 0 on the next run, forever. If a failure spent a
    # slot, then >= MAX_REFIRES_PER_RUN permanently-failing PRs (a comment POST
    # 403ing as "resource not accessible by integration" is the realistic case)
    # would consume the whole budget every run and nobody would be served --
    # the same starvation this change exists to fix, reintroduced through a
    # different door. Counting successes lets a failed write fall through to
    # the next-ranked PR instead.
    #
    # MAX_REFIRE_ATTEMPTS_PER_RUN is what keeps that from being unbounded: it
    # caps the API calls a run of failures can make, so the fall-through cannot
    # walk the entire eligible set.
    #
    # That ceiling has to cover the pre-write re-check too, and it did not
    # (PEN-3394 review). The re-check issues live reads of its own and its
    # failure branch below `continue`s without ever reaching `attempted`, so
    # a SYSTEMIC re-check failure walked every eligible PR making doomed
    # reads -- falsifying the bound this very paragraph asserts. Not
    # hypothetical: after pass 1's rate-limit `break` every later read
    # raises, so every re-check in pass 2 fails. Measured at 90 eligible PRs
    # before this counted: 90 re-check calls, 0 deferred. Pass 1 `break`s for
    # exactly this reason -- grinding out N indistinguishable per-PR failures
    # deepens the exhaustion it is reacting to.
    #
    # Counted SEPARATELY from `attempted` rather than folded into it, because
    # `attempted - succeeded` is the count of failed WRITES in the deferral
    # message below and a withheld write is not a failed one. Two counters,
    # one ceiling. The withheld branch further down still spends NEITHER: a
    # guard that answers is not a guard that failed, and it cost one read
    # that the ceiling is not there to police.
    succeeded = 0
    attempted = 0
    recheck_failures = 0
    for i in eligible:
        pr, head_sha, pending_since, _refire, reason = results[i]
        if (
            succeeded >= MAX_REFIRES_PER_RUN
            or attempted + recheck_failures >= MAX_REFIRE_ATTEMPTS_PER_RUN
        ):
            # Withheld for rate-limiting, not because nothing is wrong. The
            # PR keeps its `pending_since`, so it still counts toward
            # `considered` and can still ALARM -- rate-limiting a write must
            # never suppress the alarm.
            exhausted = (
                "over MAX_REFIRES_PER_RUN=%d this run" % MAX_REFIRES_PER_RUN
                if succeeded >= MAX_REFIRES_PER_RUN
                else "over MAX_REFIRE_ATTEMPTS_PER_RUN=%d this run "
                     "(%d re-fire write(s) failed, %d pre-write re-check(s) failed)"
                     % (
                         MAX_REFIRE_ATTEMPTS_PER_RUN,
                         attempted - succeeded,
                         recheck_failures,
                     )
            )
            results[i] = (
                pr, head_sha, pending_since, False,
                "%s -- %s, %s" % (DEFERRED_REASON_PREFIX, reason, exhausted),
            )
            continue
        if dry_run:
            # The flag stays True so the dry run's accounting and budget match
            # a live run exactly; only the side effects are withheld.
            attempted += 1
            succeeded += 1
            results[i] = (pr, head_sha, pending_since, True, "DRY-RUN would re-fire -- %s" % reason)
            continue
        # Re-read the surfaces and re-apply BOTH scan-time preconditions as
        # late as possible before the write (BLO-31908 cooldown, BLO-32044
        # already-reviewed). Pass 1's reads are minutes stale by now: a sweep
        # running concurrently -- or an operator re-asking by hand -- may have
        # posted a marker in between, and Ally may simply have answered.
        #
        # This sits AFTER the budget and dry-run branches on purpose, matching
        # the ordering this guard was written with: neither a deferred PR nor
        # a dry run is going to write, so neither should pay for its read.
        # Moving it above them would spend a request per eligible PR rather
        # than per candidate write.
        permitted, withheld, prefix = (True, None, None)
        try:
            permitted, withheld, prefix = refire_still_permitted(
                owner, repo, pr["number"], head_sha, token, api_base_url, now
            )
        except Exception as error:  # noqa: BLE001 -- isolation, as for the write below
            # The guard issues a live read, so it can fail on its own. It must
            # be isolated exactly like the write it protects: letting it
            # propagate would abort pass 2 and strand every LOWER-RANKED PR --
            # i.e. the longest-waiting ones this change exists to serve --
            # which is the whole-loop abort the decision pass already refuses.
            # Recorded as a sweep error rather than silently re-firing: the
            # guard failing open would reinstate the double-fire (BLO-31908)
            # and the re-ask-after-answer (BLO-32044) it was added to prevent.
            #
            # It spends the attempt ceiling (never the delivery cap): this
            # branch made live reads and produced no write, which is exactly
            # the shape the ceiling exists to bound. Isolation is preserved --
            # the loop still `continue`s to the next-ranked PR rather than
            # aborting, so a TRANSIENT failure here costs one slot instead of
            # stranding every longer-waiting PR below it, while a SYSTEMIC one
            # now stops after MAX_REFIRE_ATTEMPTS_PER_RUN instead of walking
            # the whole set. `break`ing on RateLimitExhausted alone was the
            # other candidate and is strictly narrower -- it would leave a
            # systemic 5xx or a network partition walking the set unbounded.
            recheck_failures += 1
            print(
                "PR #%d: pre-write re-check failed (%s: %s) -- withholding this re-fire"
                % (pr.get("number", -1), type(error).__name__, error),
                file=sys.stderr,
            )
            results[i] = (
                pr, head_sha, pending_since, False,
                "%s -- %s (%s)"
                % (SWEEP_ERROR_REASON_PREFIX, REFIRE_RECHECK_FAILURE_TOKEN, type(error).__name__),
            )
            continue
        if not permitted:
            # A withheld write is NOT a failed write, so it spends neither
            # `succeeded` nor `attempted`: the slot stays free for the next
            # ranked PR. That is the guard's own documented contract, and it
            # is also why `attempted - succeeded` stays a true count of failed
            # writes in the deferral message above -- folding withheld PRs in
            # there would report them to operators as write failures.
            if prefix == REVIEWED_SKIP_REASON_PREFIX:
                # Ally answered THIS head, so the PR is not stranded -- the
                # same normalization pass 1 does when ally_has_reviewed_head
                # is true, just discovered minutes later. Without dropping
                # pending_since, is_alarming counts the guard's HEALTHIEST
                # outcome and main() fails the run red on it. The contended
                # branch deliberately keeps pending_since: that PR genuinely
                # is still waiting and must still be able to alarm.
                pending_since = None
            results[i] = (pr, head_sha, pending_since, False, "%s -- %s" % (prefix, withheld))
            continue
        attempted += 1
        try:
            _refire_pr(owner, repo, pr, head_sha, pending_since, token, api_base_url, now)
        except Exception as error:  # noqa: BLE001 -- isolation, as in the decision pass
            # A failed write must not strand the remaining re-fires, and must
            # not read as a clean skip. RateLimitExhausted is not special-cased
            # here: unlike the read pass there is no per-PR read left to grind
            # through, the remaining writes are bounded by
            # MAX_REFIRE_ATTEMPTS_PER_RUN, and each is the job's actual
            # product -- so attempt them and let each record its own failure.
            print(
                "PR #%d: re-fire failed (%s: %s) -- continuing with the remaining re-fires"
                % (pr.get("number", -1), type(error).__name__, error),
                file=sys.stderr,
            )
            results[i] = (
                pr, head_sha, pending_since, False,
                "%s -- %s (%s)"
                % (SWEEP_ERROR_REASON_PREFIX, REFIRE_WRITE_FAILURE_TOKEN, type(error).__name__),
            )
            continue
        succeeded += 1
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description="Re-fire stalled Ally review requests.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Evaluate and report without requesting a review or posting a comment. "
             "Use this to capture a before/after stranded count on a live repo.",
    )
    args = parser.parse_args(argv)

    repo_full_name = os.environ.get("GITHUB_REPOSITORY")
    if not repo_full_name or "/" not in repo_full_name:
        raise RuntimeError("GITHUB_REPOSITORY must be set as owner/repo")
    owner, repo = repo_full_name.split("/", 1)
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("GITHUB_TOKEN must be set")
    api_base_url = os.environ.get("GITHUB_API_URL") or "https://api.github.com"

    now = time.time()
    print(
        "mode=%s stall=%ds cooldown=%ds alarm=%ds max_refires=%d%s"
        % (
            PREDICATE_MODE,
            STALL_THRESHOLD_SECONDS,
            REFIRE_COOLDOWN_SECONDS,
            ALARM_THRESHOLD_SECONDS,
            MAX_REFIRES_PER_RUN,
            " DRY-RUN (no writes)" if args.dry_run else "",
        )
    )
    results = sweep(owner, repo, token, api_base_url, now=now, dry_run=args.dry_run)
    refired = [r for r in results if r[3]]
    alarming = [
        r for r in results
        # `is_draft` is read back off the PR payload rather than hardcoded
        # False. Passing a literal was correct only because _consider_pr
        # leaves `pending_since` None for drafts -- an invariant held in a
        # different function, so the guard would have stopped guarding
        # silently if that ever changed. Keep the safety local to the check.
        if is_alarming({"is_draft": bool(r[0].get("draft")), "pending_since": r[2]}, now)
    ]
    failed = [r for r in results if str(r[4]).startswith(SWEEP_ERROR_REASON_PREFIX)]
    refire_write_failures = [r for r in failed if REFIRE_WRITE_FAILURE_TOKEN in str(r[4])]
    # The third bucket. A pre-write re-check failure is neither a read-pass
    # failure nor a failed write: the PR was fully evaluated in pass 1 (so its
    # `pending_since` and its alarm verdict are exact) and the write was
    # WITHHELD rather than rejected. It needs naming here because the DEGRADED
    # paragraph below partitions `failed`, and a bucket with no name falls
    # into whichever one is computed by subtraction.
    refire_recheck_failures = [r for r in failed if REFIRE_RECHECK_FAILURE_TOKEN in str(r[4])]
    # A write-pass failure records the EXCEPTION TYPE in its reason, so a
    # rate-limited write reads "re-fire write failed (RateLimitExhausted)" --
    # which contains RATE_LIMIT_TOKEN as a substring. Matching on that alone
    # put it in this bucket and printed "never attempted ... the run aborted"
    # over a PR that was fully evaluated and whose write was attempted and
    # rejected. Excluding write failures keeps the two apart because their
    # remedies differ: read-pass exhaustion argues for fewer reads, a
    # write-side rejection (secondary limit, or a token that cannot post)
    # does not.
    #
    # The pre-write re-check is excluded for the SAME reason: it too records
    # the exception type, so a rate-limited re-check reads
    # "re-fire pre-write re-check failed (RateLimitExhausted)" and would
    # likewise be reported as a PR the run never reached. It is a write-pass
    # read, not a read-pass one -- the PR was fully evaluated.
    rate_limited = [
        r for r in failed
        if RATE_LIMIT_TOKEN in str(r[4])
        and not is_write_pass_failure(r[4])
    ]
    # The read-pass bucket, derived ONCE here rather than inside the
    # `if degraded:` arm that used to own it. Three surfaces report on
    # `failed` -- this section's heading, the DEGRADED paragraph, and the
    # console line at the end of main() -- and only the paragraph could see
    # a derivation scoped to the paragraph. That is precisely how the heading
    # and the console line went on saying "could not be evaluated" about PRs
    # the paragraph directly beneath them described as "read in full"
    # (PEN-3394 review). Deriving it beside the buckets it partitions with
    # keeps the three surfaces answering off one number.
    #
    # Derived by EXCLUSION from WRITE_PASS_FAILURE_TOKENS, not by subtracting
    # remembered buckets: subtraction silently absorbs any bucket the
    # subtractor forgot, which is the defect this has already produced twice.
    read_failures = [r for r in failed if not is_write_pass_failure(r[4])]
    deferred = [r for r in results if str(r[4]).startswith(DEFERRED_REASON_PREFIX)]
    # The two pre-write guard outcomes. `failed`, `deferred` and `alarming`
    # each already get a summary section; these reached an operator only
    # through the per-PR stdout line, which is the wrong way round -- the
    # cooldown one is the ONLY direct evidence that dropping the concurrency
    # group (BLO-31818) has a live cost, i.e. that sweeps genuinely overlap.
    # Reported separately because they mean opposite things: see below.
    contended = [r for r in results if str(r[4]).startswith(REREAD_SKIP_REASON_PREFIX)]
    answered = [r for r in results if str(r[4]).startswith(REVIEWED_SKIP_REASON_PREFIX)]
    # Two populations, two denominators -- and the write bucket needs an
    # ABSOLUTE floor rather than a proportional one (PEN-3394 review).
    #
    # sweep_is_degraded scales its threshold with every open PR, but write-pass
    # failures cannot exceed MAX_REFIRE_ATTEMPTS_PER_RUN. Past ~100 open PRs
    # the ceiling sits BELOW the threshold, so the write population can never
    # trip the alarm on its own: measured against this script's own constants,
    # a run in which every re-fire write failed gives degraded=True at open=100
    # but False at open=111 and open=147 -- both of them this repo's own
    # recorded snapshots (review-gate-sweep.yml:45, :67). A sweep that
    # delivered ZERO re-fires would report itself healthy, which is exactly the
    # "broken and healthy produce the identical green tick" defect that
    # sweep_is_degraded's docstring says it exists to remove.
    #
    # Written as a strictly-ADDITIVE `or` rather than by re-basing the first
    # term on read_failures. The review prescribed
    # `sweep_is_degraded(len(read_failures), ...) or ... >= 3`, but that SILENCES
    # a run that alarms today: 8 read + 2 write failures over 100 considered is
    # True now and False under that form, because the 2 write failures stop
    # contributing to the proportional test without reaching the absolute one.
    # This form can only ever add a way to become degraded, never remove one.
    degraded = (
        sweep_is_degraded(len(failed), len(results))
        or len(refire_write_failures) + len(refire_recheck_failures) >= WRITE_PASS_DEGRADED_FLOOR
    )
    for pr, head_sha, pending_since, refire, reason in results:
        marker = "RE-FIRED" if refire else "skip"
        print("PR #%d (%s): %s -- %s" % (pr["number"], head_sha[:7], marker, reason))

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write("## Stalled Ally review sweep\n\n")
            handle.write("Considered %d open PR(s); re-fired %d.\n\n" % (len(results), len(refired)))
            if refired:
                handle.write("| PR | head | pending since |\n|---|---|---|\n")
                for pr, head_sha, pending_since, _refire, _reason in refired:
                    when = datetime.fromtimestamp(pending_since, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                    handle.write("| #%d | `%s` | %s |\n" % (pr["number"], head_sha[:7], when))
            if failed:
                # A PR we could not even evaluate is not "clean" -- surfacing
                # it here keeps per-PR isolation from becoming a silent cap.
                #
                # "failed", not "could not be evaluated": this section spans
                # all three buckets, and two of them WERE evaluated in full.
                # The heading used to assert the read-failure meaning over the
                # whole total, directly above a paragraph that said the
                # opposite about the same PRs (PEN-3394 review). The breakdown
                # is shared with the console line so the two cannot drift.
                handle.write(
                    "\n### :warning: %d PR(s) failed this run: %s "
                    "(isolated so the rest still swept)\n\n"
                    % (
                        len(failed),
                        failure_breakdown(
                            len(read_failures),
                            len(refire_write_failures),
                            len(refire_recheck_failures),
                        ),
                    )
                )
                if rate_limited:
                    handle.write(
                        "%d of them were never attempted: the API rate limit was exhausted "
                        "mid-sweep and the run aborted rather than grinding out one identical "
                        "failure per remaining PR.\n\n" % len(rate_limited)
                    )
                if refire_write_failures:
                    # Sits here, beside its read-pass counterpart, rather than
                    # under `if deferred:` -- write failures and deferrals are
                    # independent, and a run with failed writes but nothing
                    # deferred used to print no explanation of them at all.
                    # Phrased to hold in both cases, so hoisting it needs no
                    # extra condition.
                    handle.write(
                        "%d of them DID win a slot and were attempted -- the re-fire write "
                        "was rejected. A failed write posts no marker and so starts no "
                        "cooldown, so it does NOT consume the MAX_REFIRES_PER_RUN=%d budget "
                        "-- but it does count against MAX_REFIRE_ATTEMPTS_PER_RUN=%d, which "
                        "is what can defer an otherwise-eligible PR with fewer than %d "
                        "re-fired.\n\n"
                        % (
                            len(refire_write_failures),
                            MAX_REFIRES_PER_RUN,
                            MAX_REFIRE_ATTEMPTS_PER_RUN,
                            MAX_REFIRES_PER_RUN,
                        )
                    )
                if degraded:
                    # The run is degraded on EITHER kind of failure -- that is
                    # deliberate (see REFIRE_WRITE_FAILURE_TOKEN) and the
                    # non-zero exit stays. What differs is what each kind
                    # costs. Only a READ failure makes `alarming` unreliable:
                    # a PR whose read succeeded and whose WRITE was rejected
                    # was fully evaluated, so its pending_since is known and
                    # its alarm verdict is exact. Attributing the whole
                    # `failed` count to "could not be read" told the operator
                    # to discount the one number that was still trustworthy,
                    # on precisely the run where it is the only signal left.
                    # The COUNT is only trustworthy when no read failed, so the
                    # write clause claims it only when `read_failures` is empty.
                    #
                    # `read_failures` is derived once, up beside the buckets it
                    # partitions with, rather than here. It used to be local to
                    # this arm, which is exactly why the section heading above
                    # and the console line at the end of main() could not see
                    # it and went on contradicting this paragraph.
                    handle.write(
                        "**This run is DEGRADED** (%d of %d failed)."
                        % (len(failed), len(results))
                    )
                    if read_failures:
                        handle.write(
                            " %d could not be read, so its `alarming=%d` count is not "
                            "trustworthy -- a PR that could not be read cannot be shown "
                            "to be un-stranded, and GitHub lists open PRs newest-first, "
                            "so the ones dropped are the oldest."
                            % (len(read_failures), len(alarming))
                        )
                    if refire_write_failures:
                        handle.write(
                            " %d PR(s) were read in full and failed on the re-fire WRITE, "
                            "so their alarm verdict is exact %s is on the write side, "
                            "not in the read budget."
                            % (
                                len(refire_write_failures),
                                (
                                    "and `alarming=%d` is trustworthy; the remedy"
                                    if not read_failures
                                    else "-- they are not what makes `alarming=%d` "
                                    "unreliable; the remedy for them"
                                )
                                % len(alarming),
                            )
                        )
                    if refire_recheck_failures:
                        # Without a clause of its own this bucket rendered as
                        # a bare "**This run is DEGRADED** (3 of 3 failed)."
                        # with no account of what failed -- the exclusion
                        # above removes it from `read_failures` but cannot
                        # explain it. These PRs were read in full, so their
                        # verdict is exact; what they did NOT get is a write,
                        # which is the part an operator has to act on.
                        #
                        # Do NOT call this bucket "withheld". That word is
                        # already taken by the CLEAN guard outcome below
                        # (`### %d re-fire(s) withheld by the pre-write
                        # guard`), which spends NEITHER counter and leaves the
                        # slot free. This bucket spends the attempt ceiling.
                        # Same word, opposite budget semantics, and this
                        # summary renders both sections -- so the split has to
                        # be in the wording, not just in the code.
                        #
                        # State the budget fact; do NOT cite the deferral
                        # header's `attempted` figure for it. This clause
                        # renders on `refire_recheck_failures`, that header on
                        # `deferred` -- two independent gates, so a forward
                        # reference dangles on every run where the first is
                        # true and the second is false. That is the COMMON
                        # shape, not the corner: a deferral needs the delivery
                        # or attempt ceiling to be exceeded, while DEGRADED
                        # needs only 3 failures at >=10%, so the ordinary
                        # degraded run has a handful of re-check failures and
                        # no deferrals at all. Keep the assertion
                        # self-contained and it is true in both documents.
                        handle.write(
                            " %d PR(s) were read in full and then failed the pre-write "
                            "re-check, so no write was attempted -- though the live reads "
                            "they made do spend `MAX_REFIRE_ATTEMPTS_PER_RUN`, so they count "
                            "against this run's attempt budget. Their `pending_since` "
                            "is exact and they do not make `alarming=%d` unreliable, but "
                            "they were not served either and sort back to the front of the "
                            "next run."
                            % (len(refire_recheck_failures), len(alarming))
                        )
                    handle.write("\n\n")
                handle.write("| PR | head | reason |\n|---|---|---|\n")
                for pr, head_sha, _pending_since, _refire, reason in failed:
                    handle.write("| #%d | `%s` | %s |\n" % (pr["number"], head_sha[:7], reason))
            if deferred:
                # Over-budget PRs are real stranded work withheld only for
                # rate-limiting. Naming them keeps MAX_REFIRES_PER_RUN from
                # reading as "nothing else was wrong".
                #
                # "next scheduled run" is a claim, so it has to be earned:
                # it holds because the budget now goes to the longest wait
                # (see sweep()) and REFIRE_COOLDOWN_SECONDS drops each PR
                # just served out of eligibility for 2h, so the set rotates.
                # Before PEN-3394 this line was simply false -- spending was
                # positional over a newest-first list, so a deferred PR could
                # be deferred indefinitely, and one was for 50h.
                #
                # `len(refired)` is the count that went on COOLDOWN, which is
                # exactly what makes "those rank first next run" true -- and
                # it is only the same as "the count that won a slot" because
                # a failed write no longer consumes one.
                #
                # So it is the DELIVERED figure here too. Interpolating the
                # constant instead reported "MAX_REFIRES_PER_RUN=5 delivered"
                # on a run that delivered nothing, two lines under
                # "re-fired 0" -- a fully-spent budget over a genuine
                # starvation, which is the one reading that stops an operator
                # looking. The rotation clause has the same dependency and is
                # split out below rather than asserted unconditionally.
                handle.write(
                    "\n### %d PR(s) eligible but deferred past this run's re-fire budget "
                    "(%d of MAX_REFIRES_PER_RUN=%d delivered, "
                    "%d of MAX_REFIRE_ATTEMPTS_PER_RUN=%d attempted)\n\n"
                    % (
                        len(deferred),
                        len(refired),
                        MAX_REFIRES_PER_RUN,
                        # Measured, like the delivered figure -- and measured
                        # against the SAME ceiling it names. That ceiling is
                        # `attempted + recheck_failures` (see sweep()), so
                        # every bucket it counts has to appear here. A re-fire
                        # that reached the write either lands in `refired` or
                        # is recorded as a write failure; a pre-write re-check
                        # that FAILED made live reads and produced no write,
                        # which spends the attempt ceiling too -- that is the
                        # whole reason the ceiling counts it.
                        #
                        # Omitting that third bucket rendered "0 of
                        # MAX_REFIRE_ATTEMPTS_PER_RUN=10 attempted" beside PRs
                        # whose own per-PR reason said they were deferred for
                        # hitting exactly that 10 -- unspent budget over a
                        # genuine exhaustion, which is the same
                        # stop-looking reading the bare cap produced.
                        len(refired)
                        + len(refire_write_failures)
                        + len(refire_recheck_failures),
                        MAX_REFIRE_ATTEMPTS_PER_RUN,
                    )
                )
                if refire_write_failures or refire_recheck_failures:
                    # The guarantee is earned by the cooldown, and a re-fire
                    # that did not land posts no marker, so it starts none.
                    # Those PRs keep the longer waits that won them a slot and
                    # re-take the front of the queue ahead of everything
                    # deferred here -- the set is stationary, not rotating.
                    # Claiming otherwise reads a starvation as fairness
                    # working.
                    #
                    # BOTH buckets, because the cooldown argument does not
                    # distinguish them: a failed write and a failed pre-write
                    # re-check alike leave the PR unserved with no marker
                    # posted (the re-check branch `continue`s before
                    # `_refire_pr` is entered at all). Gating this on write
                    # failures alone told the operator the set advances on a
                    # run deferred ENTIRELY by re-check failures -- directly
                    # contradicting the failed-run paragraph 60 lines above,
                    # which says those PRs "sort back to the front of the next
                    # run", and self-refuting besides, since the `else` names
                    # `len(refired)` and that is 0 on such a run.
                    handle.write(
                        "These do **not** rank first next run: %s, and a re-fire that "
                        "did not land posts no marker so starts no cooldown. Those "
                        "PRs keep their longer waits and rank ahead of these again "
                        "until that failure is fixed.\n\n"
                        % unserved_breakdown(
                            len(refire_write_failures), len(refire_recheck_failures)
                        )
                    )
                else:
                    # A RANKING statement, deliberately not a coverage promise
                    # (PEN-3394 review). `pending_since` is static for a given
                    # head, so being served does not move it: a re-fired PR
                    # returns to rank 0 as soon as its cooldown expires, ahead
                    # of PRs never served at all. Coverage is therefore about
                    # MAX_REFIRES_PER_RUN x (cooldown / run interval) distinct
                    # PRs, and this section used to tell the operator "these
                    # rank first next run" -- false for everything below that
                    # bound, on a repo whose own snapshots record 100+ open
                    # PRs. Say what the sort guarantees and name the bound;
                    # PEN-3589 carries the round-robin fix that would make the
                    # stronger sentence true.
                    handle.write(
                        "They waited less than the %d re-fired this run, which go on "
                        "cooldown, so these rank ahead of THOSE next run.\n\n"
                        "This is a ranking statement, not a coverage guarantee: the sort "
                        "key is how long a head has been pending, and being served does "
                        "not move it, so a re-fired PR returns to the front once its "
                        "%.0fh cooldown expires. A run reaches roughly "
                        "MAX_REFIRES_PER_RUN x (cooldown / run interval) = %d distinct "
                        "PRs before the first comes round again; anything ranked below "
                        "that is not reached. Tracked in PEN-3589.\n\n"
                        % (
                            len(refired),
                            REFIRE_COOLDOWN_SECONDS / 3600.0,
                            MAX_REFIRES_PER_RUN * max(1, REFIRE_COOLDOWN_SECONDS // SWEEP_RUN_INTERVAL_SECONDS),
                        )
                    )
                handle.write("| PR | head | reason |\n|---|---|---|\n")
                for pr, head_sha, _pending_since, _refire, reason in deferred:
                    handle.write("| #%d | `%s` | %s |\n" % (pr["number"], head_sha[:7], reason))
            if contended or answered:
                handle.write(
                    "\n### %d re-fire(s) withheld by the pre-write guard\n\n"
                    % (len(contended) + len(answered))
                )
                if contended:
                    # The signal worth escalating on. Rare by design -- hourly
                    # cadence, ~2min run, 2h cooldown -- so a routinely
                    # non-zero count means sweeps really are overlapping and
                    # the residual documented on refire_still_permitted is
                    # live rather than theoretical.
                    handle.write(
                        "- **%d contended**: a marker was posted between this run's scan and "
                        "its write, so a CONCURRENT SWEEP re-asked first (BLO-31908). This is "
                        "the measurable cost of carrying no `concurrency` group (BLO-31818). "
                        "Expected to be 0 or 1; if it is routinely higher, sweeps are "
                        "overlapping and the guard's stated residual is live.\n"
                        % len(contended)
                    )
                if answered:
                    handle.write(
                        "- **%d answered**: Ally reviewed the head between this run's scan and "
                        "its write (BLO-32044), so the PR is no longer stranded. This one is "
                        "healthy -- the guard suppressed a redundant re-ask; it implies nothing "
                        "about contention.\n"
                        % len(answered)
                    )
                handle.write("\n| PR | head | reason |\n|---|---|---|\n")
                for pr, head_sha, _pending_since, _refire, reason in contended + answered:
                    handle.write("| #%d | `%s` | %s |\n" % (pr["number"], head_sha[:7], reason))
            if alarming:
                handle.write(
                    "\n### :rotating_light: %d PR(s) pending past the alarm threshold "
                    "(%.1fh) -- a re-fire has not resolved this; needs a human\n\n"
                    % (len(alarming), ALARM_THRESHOLD_SECONDS / 3600.0)
                )
                handle.write("| PR | head | pending since |\n|---|---|---|\n")
                for pr, head_sha, pending_since, _refire, _reason in alarming:
                    when = datetime.fromtimestamp(pending_since, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                    handle.write("| #%d | `%s` | %s |\n" % (pr["number"], head_sha[:7], when))

    print(
        "considered=%d refired=%d alarming=%d failed=%d deferred=%d"
        % (len(results), len(refired), len(alarming), len(failed), len(deferred))
    )
    if alarming:
        # Non-zero exit turns this scheduled job persistently red instead of
        # a `pending` commit status nobody is watching -- BLO-22892 AC4: the
        # stranded condition must surface without a human noticing by hand.
        print(
            "ALARM: %d PR(s) still pending past %.1fh despite an automated re-fire cycle -- "
            "review-gate-sweep failing on purpose so this is visible on the Actions tab."
            % (len(alarming), ALARM_THRESHOLD_SECONDS / 3600.0),
            file=sys.stderr,
        )
        sys.exit(EXIT_ALARM)
    if degraded:
        # Distinct from the alarm above, and checked second so a genuine
        # stranded PR still reports as a stranded PR. Exiting green here would
        # make a systematically broken sweep indistinguishable from a working
        # one, which is the exact defect class this reconciler exists to
        # remove -- so the non-zero exit is unconditional.
        #
        # WHAT it reports is not, and that is the PEN-3394 review fix. This
        # line used to assert, over the whole `failed` total, that "the sweep
        # itself did not run" and that `alarming` was untrustworthy. Both are
        # read-failure statements. On a run whose failures are all write-pass,
        # every PR WAS read in full and `alarming` is exact -- so the console
        # was contradicting the step summary about the same PRs, on the same
        # number, in the same run. The branch below says only what the bucket
        # in hand supports.
        breakdown = failure_breakdown(
            len(read_failures),
            len(refire_write_failures),
            len(refire_recheck_failures),
        )
        if read_failures:
            # `rate_limited` is a subset of `read_failures` (it excludes the
            # write-pass tokens), so its note can only ever belong on this
            # branch -- carrying it to the other one would be dead code that
            # reads like a live case.
            print(
                "SWEEP DEGRADED: %d of %d PR(s) failed (%s)%s -- review-gate-sweep failing "
                "because %d of them could not be read, NOT because a PR is stranded. "
                "`alarming=%d` is not a clean bill of health on this run: a PR that could "
                "not be read cannot be shown to be un-stranded."
                % (
                    len(failed),
                    len(results),
                    breakdown,
                    " (API rate limit exhausted mid-sweep)" if rate_limited else "",
                    len(read_failures),
                    len(alarming),
                ),
                file=sys.stderr,
            )
        else:
            print(
                "SWEEP DEGRADED: %d of %d PR(s) failed (%s) -- review-gate-sweep failing "
                "because the re-fire did not land, NOT because the sweep could not run. "
                "Every one of these PRs was read in full, so `alarming=%d` IS exact; they "
                "were not served either, and sort back to the front of the next run."
                % (len(failed), len(results), breakdown, len(alarming)),
                file=sys.stderr,
            )
        sys.exit(EXIT_SWEEP_DEGRADED)


def _dispatch():
    """Run `main()` under the abort-vs-alarm exit-code policy.

    A function rather than a bare `if __name__ == "__main__"` body so the arms
    below are reachable from the test suite. They were not, and that is why
    the `http.client` hole sat open: every arm here is a guard whose whole
    purpose is to fire on a path nothing else exercises, and an unreachable
    guard is a comment. Tests assert each arm's exit code by calling this.
    """
    # Every arm here exits EXIT_SWEEP_DEGRADED, never EXIT_ALARM: reaching
    # this handler means the sweep aborted outright (typically on the initial
    # open-PR list, before any PR was evaluated), so nothing is known about
    # whether a PR is stranded. Reporting that as the stranded-PR alarm would
    # send a human looking for a PR to review when the actual fault is that
    # the reconciler could not talk to GitHub.
    #
    # review-gate-sweep.yml fails the job on ANY non-zero exit, so choosing
    # EXIT_SWEEP_DEGRADED over EXIT_ALARM does not turn a red run green. What
    # it buys is that the red is correctly DIAGNOSED -- "could not talk to
    # GitHub" rather than "go review a stranded PR". Judge these arms on the
    # log line, not on the workflow conclusion.
    try:
        main()
    except RateLimitExhausted as error:
        print("GitHub API rate limit exhausted before the sweep could run: %s" % error, file=sys.stderr)
        sys.exit(EXIT_SWEEP_DEGRADED)
    except urllib.error.HTTPError as error:
        print("GitHub API request failed: %s %s" % (error.code, error.read()), file=sys.stderr)
        sys.exit(EXIT_SWEEP_DEGRADED)
    except urllib.error.URLError as error:
        # Transport failure (DNS, TLS, connection reset, timeout). HTTPError is
        # a subclass of URLError, so this arm must come second or it would
        # shadow the status-code message above.
        print("GitHub API request failed (transport): %s" % error.reason, file=sys.stderr)
        sys.exit(EXIT_SWEEP_DEGRADED)
    except http.client.HTTPException as error:
        # A truncated or malformed response body raises from `http.client`,
        # whose exception tree hangs off Exception and NOT off OSError:
        #
        #     IncompleteRead -> HTTPException -> Exception
        #     URLError       -> OSError
        #
        # So none of the arms above and none below catch it, and uncaught it
        # exits 1 == EXIT_ALARM -- a truncated GitHub page reporting itself as
        # "a PR is stranded, go review it". Measured live on run 35605218498
        # (2026-09-21T13:22Z): `IncompleteRead(703602 bytes read, 68373 more
        # expected)` while paginating the open-PR list, which a human then had
        # to read a traceback to tell apart from a real alarm. Exactly the
        # hazard the OSError arm below already documents, arriving through the
        # one door that arm cannot cover (BLO-35151).
        #
        # Catch the HTTPException BASE, not IncompleteRead: BadStatusLine and
        # LineTooLong are siblings with identical consequences, and naming
        # only the subclass we happened to observe would leave the same hole.
        #
        # No retry here on purpose. The sweep runs hourly and is idempotent,
        # so the schedule already supplies the retry; the 13:22Z truncation
        # self-healed at 14:24Z on the same commit. Retrying in-process would
        # add a failure mode to buy back an hour that costs nothing.
        print("GitHub API request failed (malformed or truncated HTTP response): %r" % error, file=sys.stderr)
        sys.exit(EXIT_SWEEP_DEGRADED)
    except OSError as error:
        # A REQUEST_TIMEOUT_SECONDS expiry during the response *read* raises a
        # bare TimeoutError (== socket.timeout), which is an OSError but NOT a
        # URLError -- only the connect phase gets wrapped by urllib. Without
        # this arm it escapes as an uncaught traceback, and CPython exits 1 --
        # which is EXIT_ALARM. The timeout added to bound a hung request would
        # then report itself as "a PR is stranded, go review it", sending a
        # human to look for work that does not exist. Caught last: URLError is
        # itself an OSError, so the arms above still take precedence.
        print("GitHub API request failed (socket): %r" % error, file=sys.stderr)
        sys.exit(EXIT_SWEEP_DEGRADED)
    except Exception:
        # Terminal arm: any exception class not enumerated above (e.g. a
        # json.JSONDecodeError == ValueError from _request()'s json.loads on a
        # 200 carrying a non-JSON proxy/WAF page during the unisolated open-PR
        # pagination) would otherwise escape and exit 1 == EXIT_ALARM. Anything
        # reaching here by definition never finished reading the PR list, so it
        # is degraded, not an alarm. `Exception`, NOT `BaseException`: main()'s
        # deliberate sys.exit(EXIT_ALARM) raises SystemExit, which must pass
        # through untouched (BLO-35151).
        print("GitHub API sweep crashed before completing: %s" % traceback.format_exc(), file=sys.stderr)
        sys.exit(EXIT_SWEEP_DEGRADED)


def run_cli():
    """Run `_dispatch()` under the abort-vs-alarm exit-code policy; see its docstring."""
    try:
        _dispatch()
    except Exception:
        # The arm BODIES in _dispatch() are siblings of its terminal arm, not
        # inside its try: an exception raised while REPORTING a failure (live
        # case: `error.read()` on an HTTPError re-raising IncompleteRead off
        # the socket) would escape and exit 1 == EXIT_ALARM. `Exception`, not
        # `BaseException`, so each arm's own sys.exit(SystemExit) passes
        # through untouched (BLO-35151).
        print("GitHub API sweep crashed while reporting a failure: %s" % traceback.format_exc(), file=sys.stderr)
        sys.exit(EXIT_SWEEP_DEGRADED)


if __name__ == "__main__":
    run_cli()

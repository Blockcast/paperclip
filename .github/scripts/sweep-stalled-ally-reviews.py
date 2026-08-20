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
import json
import os
import re
import sys
import time
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


# The immutable head attestation Ally writes into every consolidated body:
# a standalone "Reviewed head: <40 lowercase hex>" line. This is what binds a
# signal to a revision -- NOT review.commit_id, and NOT a substring scan.
REVIEWED_HEAD_PATTERN = re.compile(
    r"^[ \t]*Reviewed head:[ \t]*([0-9a-f]{40})[ \t]*$", re.IGNORECASE | re.MULTILINE
)


def parse_reviewed_head(body):
    """Return the single attested head OID, or None.

    Requires EXACTLY ONE standalone attestation line. Zero means the body makes
    no claim about which revision it covers; more than one is ambiguous. Both
    fail closed -- the caller treats them as "not a signal for this head".
    """
    matches = REVIEWED_HEAD_PATTERN.findall(body or "")
    if len(matches) != 1:
        return None
    return matches[0].lower()


def attests_head(body, head_sha):
    """Exact equality against the parsed attestation.

    Deliberately not a substring test: a body that reviewed revision X but
    happens to mention revision Y in prose ("superseded by Y") must not count
    as a signal for Y.
    """
    attested = parse_reviewed_head(body)
    return attested is not None and attested == head_sha.lower()


def is_consolidated_ally_comment_for_head(body, head_sha):
    return (
        body.startswith("## Ally")
        and "Consolidated PR Review" in body
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
# stranded rather than "just waiting its turn". Ally's own documented
# response times in BLO-22892 were 6m35s and 30m when the wake landed; 90m
# gives generous headroom above that before treating silence as loss.
STALL_THRESHOLD_SECONDS = int(os.environ.get("STALL_THRESHOLD_SECONDS") or 90 * 60)

# Don't re-fire more than once per cooldown window even if still stalled --
# the sweep itself must not become the burst that re-triggers whatever
# capacity gate declined the original wake. A human/agent can still re-fire
# manually inside the cooldown; this only throttles the AUTOMATED re-ask.
REFIRE_COOLDOWN_SECONDS = int(os.environ.get("REFIRE_COOLDOWN_SECONDS") or 2 * 60 * 60)

# Ceiling on re-fires per run. The trafficcontrol original needed no such cap:
# its status pre-filter naturally bounded the candidate set to heads a gate
# had recently touched. `status-free` mode has no such bound -- on a repo with
# a long tail of old open PRs the FIRST run would otherwise request a review
# on every one of them at once, which is the thundering herd this script's own
# cooldown exists to avoid. Over-limit PRs are not dropped silently: they are
# reported as deferred, still counted in `considered`, and still alarm.
MAX_REFIRES_PER_RUN = int(os.environ.get("MAX_REFIRES_PER_RUN") or 5)

# BLO-22892 AC4: the stranded condition must be visible without a human
# noticing by hand. A re-fired request can itself go unserviced (that's the
# whole failure mode this script backstops), so "we re-fired it" is not
# evidence of health. Once a head has been awaiting review long enough that at
# least one automated re-fire + its cooldown should have resolved it, the
# sweep fails its own CI check -- turning silence into a persistently red
# scheduled run, rather than a status nobody is watching. Deliberately >
# STALL_THRESHOLD_SECONDS + REFIRE_COOLDOWN_SECONDS by a margin, so this
# alarms on "the re-fire didn't work either", not on the same signal that
# just triggered a re-fire.
ALARM_THRESHOLD_SECONDS = int(
    os.environ.get("ALARM_THRESHOLD_SECONDS") or (STALL_THRESHOLD_SECONDS + REFIRE_COOLDOWN_SECONDS + 60 * 60)
)

MARKER = "<!-- paperclip:review-request -->"

# Prefix for the reason recorded when a single PR could not be evaluated.
# sweep() isolates such failures so one bad PR cannot strand the rest; main()
# keys off this to report them rather than letting them read as clean skips.
SWEEP_ERROR_REASON_PREFIX = "skip: error"

# Prefix for the reason recorded when a PR was stranded and eligible but hit
# MAX_REFIRES_PER_RUN. Distinct from a clean skip so main() can report it.
DEFERRED_REASON_PREFIX = "skip: deferred"


def _request(url, token, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", "Bearer %s" % token)
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as response:
        body = response.read()
        return json.loads(body) if body else None


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
    if pr["existing_marker_epochs"]:
        last_marker = max(pr["existing_marker_epochs"])
        since_last = now - last_marker
        if since_last < REFIRE_COOLDOWN_SECONDS:
            return False, "re-asked %ds ago < cooldown %ds" % (int(since_last), REFIRE_COOLDOWN_SECONDS)
    return True, "pending %ds >= threshold %ds" % (int(age), STALL_THRESHOLD_SECONDS)


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


def build_comment_body(pr_number, head_sha, age_seconds, requested_login=None, mode=None):
    """The durable audit trail for a re-fire, and the cooldown input.

    The opening sentence is mode-aware on purpose. In `status-free` mode there
    is no `review/ally-complete` check on the repo at all, so the original
    wording ("this PR's `review/ally-complete` check has been `pending`")
    would assert a signal that does not exist -- misleading anyone who then
    goes looking for it on the Checks tab.
    """
    hours = age_seconds / 3600.0
    mode = mode or PREDICATE_MODE
    request_line = (
        "Requested a review from @%s directly (native GitHub review request, "
        "not just this comment) against current head `%s`.\n" % (requested_login, head_sha[:7])
        if requested_login
        else "Attempted to request a review from @%s directly; that call failed, so this "
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


def unreviewed_since(pr_payload, head_commit_payload):
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

    Returns None if neither timestamp can be parsed, which the caller treats
    as "not awaiting review" -- fail closed toward not spamming.
    """
    candidates = []
    created_at = (pr_payload or {}).get("created_at")
    if created_at:
        try:
            candidates.append(_parse_iso(created_at))
        except (ValueError, TypeError):
            pass
    commit = (head_commit_payload or {}).get("commit") or {}
    committer_date = (commit.get("committer") or {}).get("date")
    if committer_date:
        try:
            candidates.append(_parse_iso(committer_date))
        except (ValueError, TypeError):
            pass
    return max(candidates) if candidates else None


def _consider_pr(owner, repo, pr, token, api_base_url, now, may_refire=True, dry_run=False):
    """Evaluate one open PR and, if it is stranded, re-fire the request and
    post the marker comment. Returns the result tuple for the accounting.
    Network failures propagate to sweep(), which isolates them per-PR.

    `may_refire` False means the run's MAX_REFIRES_PER_RUN budget is spent.
    The PR is still fully evaluated -- so it still counts toward `considered`
    and can still ALARM -- but the two write calls are withheld and the
    reason is marked deferred. Skipping evaluation instead would hide a
    stranded PR behind a rate limit, which is the silent cap this must not be.

    `dry_run` reports the decision without issuing either write. The returned
    re-fire flag stays True so the caller's accounting and budget match a live
    run exactly; only the side effects are withheld.
    """
    number = pr["number"]
    is_draft = bool(pr.get("draft"))
    head_sha = pr["head"]["sha"]
    pending_since = None
    marker_epochs = []
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
            pending_since = unreviewed_since(pr, head_commit)
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
                marker_epochs = [
                    _parse_iso(c["created_at"])
                    for c in comments
                    if str(c.get("body") or "").startswith(MARKER)
                ]
    decision_input = {
        "number": number,
        "is_draft": is_draft,
        "pending_since": pending_since,
        "existing_marker_epochs": marker_epochs,
    }
    refire, reason = should_refire(decision_input, now)
    if refire and not may_refire:
        return (
            pr,
            head_sha,
            pending_since,
            False,
            "%s -- %s, over MAX_REFIRES_PER_RUN=%d this run" % (DEFERRED_REASON_PREFIX, reason, MAX_REFIRES_PER_RUN),
        )
    if refire and dry_run:
        return (pr, head_sha, pending_since, True, "DRY-RUN would re-fire -- %s" % reason)
    if refire:
        requested = request_review(owner, repo, number, token, api_base_url)
        body = build_comment_body(
            number, head_sha, now - pending_since,
            requested_login=ALLY_REQUEST_REVIEWER_LOGIN if requested else None,
        )
        _request(
            "%s/repos/%s/%s/issues/%d/comments" % (api_base_url.rstrip("/"), owner, repo, number),
            token,
            method="POST",
            payload={"body": body},
        )
    return (pr, head_sha, pending_since, refire, reason)


def sweep(owner, repo, token, api_base_url, now=None, dry_run=False):
    """List open PRs, decide, and re-fire. Returns the list of (pr, reason)
    for every non-draft open PR considered, in list order, so the caller can
    print a full accounting -- not just the ones actioned (no silent caps).

    Each PR is evaluated in isolation. A failure against one PR must never
    strand the others: this sweep *is* the reconciler for stranded PRs, so
    letting a single transient error abort the loop would reinstate exactly
    the defect it exists to clear (BLO-22892) -- and silently, since the
    remaining PRs would simply never be considered.

    `dry_run` evaluates every PR and reports what it WOULD do without issuing
    either write (the reviewer re-request or the marker comment). It exists so
    the before/after predicate counts required by BLO-28203's verifying signal
    can be captured from a real repo without mutating it.
    """
    now = now if now is not None else time.time()
    prs = _fetch_paginated(api_base_url, "/repos/%s/%s/pulls?state=open" % (owner, repo), token)
    results = []
    refires_left = MAX_REFIRES_PER_RUN
    for pr in prs:
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
            outcome = _consider_pr(
                owner, repo, pr, token, api_base_url, now,
                may_refire=(refires_left > 0),
                dry_run=dry_run,
            )
            if outcome[3]:
                # True in a dry run means "would have re-fired". Decrementing
                # on that too is what makes the dry run's plan match what a
                # live run would really do, cap included.
                refires_left -= 1
            results.append(outcome)
        except Exception as error:  # noqa: BLE001 -- deliberate per-PR isolation
            print(
                "PR #%d: sweep failed (%s: %s) -- continuing with the remaining PRs"
                % (pr.get("number", -1), type(error).__name__, error),
                file=sys.stderr,
            )
            results.append((pr, head_sha, None, False, "%s -- %s" % (SWEEP_ERROR_REASON_PREFIX, type(error).__name__)))
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
        if is_alarming({"is_draft": False, "pending_since": r[2]}, now)
    ]
    failed = [r for r in results if str(r[4]).startswith(SWEEP_ERROR_REASON_PREFIX)]
    deferred = [r for r in results if str(r[4]).startswith(DEFERRED_REASON_PREFIX)]
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
                handle.write(
                    "\n### :warning: %d PR(s) could not be evaluated this run "
                    "(isolated so the rest still swept)\n\n" % len(failed)
                )
                handle.write("| PR | head | reason |\n|---|---|---|\n")
                for pr, head_sha, _pending_since, _refire, reason in failed:
                    handle.write("| #%d | `%s` | %s |\n" % (pr["number"], head_sha[:7], reason))
            if deferred:
                # Over-budget PRs are real stranded work withheld only for
                # rate-limiting. Naming them keeps MAX_REFIRES_PER_RUN from
                # reading as "nothing else was wrong".
                handle.write(
                    "\n### %d PR(s) eligible but deferred past MAX_REFIRES_PER_RUN=%d "
                    "(they will be picked up on the next scheduled run)\n\n"
                    % (len(deferred), MAX_REFIRES_PER_RUN)
                )
                handle.write("| PR | head | reason |\n|---|---|---|\n")
                for pr, head_sha, _pending_since, _refire, reason in deferred:
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
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        print("GitHub API request failed: %s %s" % (error.code, error.read()), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as error:
        # Transport failure (DNS, TLS, connection reset, timeout). HTTPError is
        # a subclass of URLError, so this arm must come second or it would
        # shadow the status-code message above.
        print("GitHub API request failed (transport): %s" % error.reason, file=sys.stderr)
        sys.exit(1)

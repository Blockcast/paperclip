#!/usr/bin/env python3
"""Pins the branches of sweep-stalled-ally-reviews.py's pure decision logic.

Stdlib only, no network -- first_pending_since(), should_refire(),
is_alarming(), and ally_has_reviewed_head() are pure functions.
Run: python3 -m unittest discover -s .github/scripts -p 'test_*.py'
"""

import contextlib
import http.client
import importlib.util
import io
import os
import tempfile
import time
from datetime import datetime, timezone
import unittest
import urllib.error

_SPEC = importlib.util.spec_from_file_location(
    "sweep_stalled_ally_reviews",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "sweep-stalled-ally-reviews.py"),
)
sweep = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(sweep)

CONTEXT = sweep.STATUS_CONTEXT
HOUR = 3600.0

# The instant the two pre-write guard suites anchor their fixtures on. Every
# other instant they use is DERIVED from it and from the calibrated thresholds
# (STALL_THRESHOLD_SECONDS, REFIRE_COOLDOWN_SECONDS), never typed as a
# literal: the thresholds are recalibrated as the fleet changes (BLO-34521
# moved the stall threshold from 8h to 18h), and a literal "now" that used to
# sit past the threshold silently stops satisfying should_refire, at which
# point the guard under test is never reached and every assertion about it
# fails for a reason none of them name.
PENDING_SINCE = "2026-09-01T00:00:00Z"


def _iso(epoch):
    """Inverse of sweep._parse_iso, for fixture instants derived from `now`."""
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def status(state, created_at):
    return {"context": CONTEXT, "state": state, "created_at": created_at}


class TestFirstPendingSince(unittest.TestCase):
    def test_no_statuses_for_context_is_not_pending(self):
        self.assertIsNone(sweep.first_pending_since([]))
        other = [{"context": "other/check", "state": "pending", "created_at": "2026-08-06T14:00:00Z"}]
        self.assertIsNone(sweep.first_pending_since(other))

    def test_resolved_success_is_not_pending(self):
        statuses = [
            status("success", "2026-08-06T15:00:00Z"),
            status("pending", "2026-08-06T14:00:00Z"),
        ]
        self.assertIsNone(sweep.first_pending_since(statuses))

    def test_single_pending_uses_its_own_timestamp(self):
        statuses = [status("pending", "2026-08-06T14:00:00Z")]
        self.assertEqual(sweep.first_pending_since(statuses), sweep._parse_iso("2026-08-06T14:00:00Z"))

    def test_repeated_pending_reposts_use_the_oldest_timestamp(self):
        # review-gate.yml reposts an identical `pending` status on every
        # subsequent PR event. The age must be measured from the FIRST one,
        # not the most recent repost, or every re-trigger resets the clock
        # and a stranded PR never crosses the staleness threshold.
        statuses = [
            status("pending", "2026-08-07T15:57:44Z"),
            status("pending", "2026-08-07T09:11:00Z"),
            status("pending", "2026-08-06T14:01:00Z"),
        ]
        self.assertEqual(sweep.first_pending_since(statuses), sweep._parse_iso("2026-08-06T14:01:00Z"))

    def test_pending_after_an_intervening_resolution_uses_the_new_run_not_the_old_one(self):
        # pending -> success -> pending (e.g. a CHANGES_REQUESTED review later
        # dismissed) is a NEW continuous wait, not a continuation of the first
        # one. Carrying the oldest-ever pending timestamp across the resolved
        # boundary would let a head that only just went pending again read as
        # already stale, and alarm immediately.
        statuses = [
            status("pending", "2026-08-07T15:00:00Z"),  # newest: current wait
            status("success", "2026-08-07T10:00:00Z"),  # resolution boundary
            status("pending", "2026-08-06T09:00:00Z"),  # oldest: prior wait
        ]
        self.assertEqual(sweep.first_pending_since(statuses), sweep._parse_iso("2026-08-07T15:00:00Z"))

    def test_same_second_timestamps_trust_api_order_not_a_re_sort(self):
        # native-codex finding on #1383: created_at is only second-resolution,
        # so an initial `pending` immediately followed by a resolution can
        # share a timestamp. GitHub returns statuses newest-first (success
        # here, the true most-recent event); a re-sort keyed on that tied
        # timestamp must not treat the older `pending` entry as the newest
        # and read an already-resolved head as freshly pending.
        statuses = [
            status("success", "2026-08-07T15:00:00Z"),
            status("pending", "2026-08-07T15:00:00Z"),
        ]
        self.assertIsNone(sweep.first_pending_since(statuses))

    def test_pending_after_intervening_resolution_still_collapses_its_own_reposts(self):
        # Combines both behaviours: the current run's reposts collapse to its
        # own oldest entry, without reaching back past the resolution.
        statuses = [
            status("pending", "2026-08-07T15:57:44Z"),
            status("pending", "2026-08-07T12:00:00Z"),
            status("success", "2026-08-07T10:00:00Z"),
            status("pending", "2026-08-06T09:00:00Z"),
        ]
        self.assertEqual(sweep.first_pending_since(statuses), sweep._parse_iso("2026-08-07T12:00:00Z"))


class TestShouldRefire(unittest.TestCase):
    def base_pr(self, **overrides):
        pr = {
            "number": 1366,
            "is_draft": False,
            "pending_since": 0.0,
            "existing_marker_epochs": [],
        }
        pr.update(overrides)
        return pr

    def test_draft_is_excluded_even_if_stale(self):
        pr = self.base_pr(is_draft=True, pending_since=0.0)
        refire, reason = sweep.should_refire(pr, now=100 * HOUR)
        self.assertFalse(refire)
        self.assertEqual(reason, "draft")

    def test_never_pending_is_excluded(self):
        pr = self.base_pr(pending_since=None)
        refire, _reason = sweep.should_refire(pr, now=100 * HOUR)
        self.assertFalse(refire)

    def test_pending_but_not_yet_stale_is_excluded(self):
        pr = self.base_pr(pending_since=0.0)
        just_under_threshold = sweep.STALL_THRESHOLD_SECONDS - 1
        refire, _reason = sweep.should_refire(pr, now=just_under_threshold)
        self.assertFalse(refire)

    def test_pending_past_threshold_with_no_prior_reask_is_refired(self):
        pr = self.base_pr(pending_since=0.0)
        just_over_threshold = sweep.STALL_THRESHOLD_SECONDS + 1
        refire, _reason = sweep.should_refire(pr, now=just_over_threshold)
        self.assertTrue(refire)

    def test_stale_but_recently_reasked_respects_cooldown(self):
        now = sweep.STALL_THRESHOLD_SECONDS + sweep.REFIRE_COOLDOWN_SECONDS
        pr = self.base_pr(pending_since=0.0, existing_marker_epochs=[now - 60])
        refire, reason = sweep.should_refire(pr, now=now)
        self.assertFalse(refire)
        self.assertIn("cooldown", reason)

    def test_stale_and_cooldown_expired_is_refired_again(self):
        now = sweep.STALL_THRESHOLD_SECONDS + sweep.REFIRE_COOLDOWN_SECONDS + 1
        pr = self.base_pr(pending_since=0.0, existing_marker_epochs=[1.0])
        refire, _reason = sweep.should_refire(pr, now=now)
        self.assertTrue(refire)

    def test_cooldown_keys_on_the_most_recent_marker_not_the_first(self):
        # Two prior re-asks: an old one outside cooldown and a fresh one
        # inside it. Only the most recent should gate -- an operator's manual
        # re-ask five minutes ago must suppress the sweep even if the very
        # first automated re-ask was long enough ago to have expired alone.
        now = sweep.STALL_THRESHOLD_SECONDS + sweep.REFIRE_COOLDOWN_SECONDS + 100
        pr = self.base_pr(
            pending_since=0.0,
            existing_marker_epochs=[1.0, now - 300],
        )
        refire, reason = sweep.should_refire(pr, now=now)
        self.assertFalse(refire)
        self.assertIn("cooldown", reason)


class TestIsAlarming(unittest.TestCase):
    def base_pr(self, **overrides):
        pr = {"is_draft": False, "pending_since": 0.0}
        pr.update(overrides)
        return pr

    def test_draft_never_alarms(self):
        pr = self.base_pr(is_draft=True)
        self.assertFalse(sweep.is_alarming(pr, now=10 * sweep.ALARM_THRESHOLD_SECONDS))

    def test_never_pending_never_alarms(self):
        pr = self.base_pr(pending_since=None)
        self.assertFalse(sweep.is_alarming(pr, now=10 * sweep.ALARM_THRESHOLD_SECONDS))

    def test_below_alarm_threshold_does_not_alarm(self):
        pr = self.base_pr(pending_since=0.0)
        self.assertFalse(sweep.is_alarming(pr, now=sweep.ALARM_THRESHOLD_SECONDS - 1))

    def test_past_alarm_threshold_alarms_regardless_of_refire_history(self):
        # A PR re-fired hours ago and still pending is exactly the case that
        # must alarm -- a prior re-fire is not evidence the problem resolved.
        pr = self.base_pr(pending_since=0.0)
        self.assertTrue(sweep.is_alarming(pr, now=sweep.ALARM_THRESHOLD_SECONDS + 1))

    def test_alarm_threshold_exceeds_stall_plus_cooldown(self):
        # The alarm must not fire on the same signal that just triggered a
        # re-fire -- it needs strictly more headroom than stall+cooldown so a
        # freshly-stranded PR gets its automated chance first.
        self.assertGreater(
            sweep.ALARM_THRESHOLD_SECONDS,
            sweep.STALL_THRESHOLD_SECONDS + sweep.REFIRE_COOLDOWN_SECONDS,
        )


class TestStallThresholdCalibration(unittest.TestCase):
    """The threshold must clear the measured distribution OF THE QUANTITY IT
    CLOCKS, with the margin its derivation claims.

    This is the defect BLO-34521 fixed, and the second half is the defect the
    first version of that fix walked into. At 90m the predicate was
    effectively constant-true -- 96-99% of *healthy* dispatches breached it --
    so "stranded" meant "dispatched normally". The replacement, 8h, was
    derived from `startedAt - createdAt` and breached 0% of THAT. But the
    threshold is compared against `unreviewed_since()`, so what it really
    clocks is head-landed -> review, of which dispatch wait is one term of
    four; measured directly, 8h breached 19.4%. At the 1.35 multiplier in
    force when 8h shipped, a table carrying only `dispatch-wait` rows passed
    it -- which is how 8h cleared its own guard.

    So the `quantity` column is load-bearing, not documentation: at least one
    row must measure end-to-end, or this guard cannot see the failure it
    exists to catch. If you change STALL_THRESHOLD_SECONDS, re-run the
    reproduction recorded in the comment block above it and update this table
    in the same commit -- a constant whose derivation is not re-measured is
    how this rotted twice.

    Read the column as the structural protection and nothing else. At today's
    1.41 the `n=725` dispatch-wait row happens to refuse 8h on its own
    (30033s floor against 28800s), so the end-to-end row is not currently the
    only thing standing between this guard and the regression -- but that is
    an accident of how starved the queue is, not a property of the design.
    The BLO-19881 paragraph in `sweep-stalled-ally-reviews.py` (grep it, do
    not cite its line -- these shift) expects dispatch wait to come back DOWN
    if that lands, which lowers both dispatch-wait floors and hands the
    refusal back to the end-to-end row alone. The column is what holds
    independently of the multiplier and of the queue.
    """

    END_TO_END = "unreviewed_since->review"

    # Picked off p90, never off the max -- the end-to-end tail is heavy
    # (p90 12.70h against max 30.81h), and chasing the max would mean a 32h
    # threshold: a day and a half to notice a lost review, bought against the
    # 11/232 (4.7%) above 18h. This is the multiplier the derivation actually
    # claims, floored to 2dp: 1080/762 = 1.417. It was 1.35, which is not a
    # claim anything makes
    # -- a floor ~5% under the asserted margin, i.e. the guard relaxed until
    # it admitted the chosen value. At 1.41 the slack is 0.5%, so the guard
    # now refuses any constant that does not clear the margin in the prose.
    P90_MULTIPLIER = 1.41

    # (window label, quantity, p90 minutes)
    OBSERVED_WINDOWS = [
        ("2026-09-16T22:37Z->2026-09-18T05:50Z n=706", "dispatch-wait", 338),
        ("2026-09-17T19:19Z->2026-09-18T21:54Z n=725", "dispatch-wait", 355),
        ("2026-09-13T17:37Z->2026-09-19T05:25Z n=232", END_TO_END, 762),
    ]

    def test_threshold_clears_every_observed_p90_with_its_claimed_margin(self):
        # subTest, not a bare loop: a regression must report EVERY row it
        # breaks. Without it the first failure stops the loop, and since the
        # dispatch-wait rows come first, a revert to 8h reports only those --
        # hiding the end-to-end row, which is the one this class exists to
        # make load-bearing.
        for label, quantity, p90_minutes in self.OBSERVED_WINDOWS:
            with self.subTest("%s (%s)" % (label, quantity)):
                self.assertGreaterEqual(
                    sweep.STALL_THRESHOLD_SECONDS,
                    self.P90_MULTIPLIER * p90_minutes * 60,
                    "%s (%s)" % (label, quantity),
                )

    def test_table_measures_the_quantity_the_predicate_clocks(self):
        # Without this, the table degrades to dispatch-wait rows only. That is
        # exactly what let 8h pass its own guard at the 1.35 multiplier then
        # in force, while breaching 19.4% of real reviews. At today's 1.41 a
        # dispatch-wait-only table would refuse 8h anyway, on the `n=725` row
        # -- so this assertion is not what is stopping that regression right
        # now. It is what stops it once the queue recovers and those floors
        # drop back. `unreviewed_since()` is what STALL_THRESHOLD_SECONDS is
        # compared against, so a row measuring it is the minimum evidence.
        self.assertTrue(
            any(q == self.END_TO_END for _, q, _ in self.OBSERVED_WINDOWS),
            "no end-to-end window recorded; dispatch wait alone cannot calibrate this",
        )

    def test_old_ninety_minute_value_would_fail_this_calibration(self):
        # Guard the guard: if this assertion ever passes at 90m, the table
        # above has been emptied or the comparison inverted, and the test is
        # no longer capable of catching a regression to the rotted value.
        worst_p90 = max(p90 for _, _, p90 in self.OBSERVED_WINDOWS)
        self.assertLess(90 * 60, self.P90_MULTIPLIER * worst_p90 * 60)

    def test_superseded_eight_hour_value_would_fail_this_calibration(self):
        # The same guard for the value this replaced. Asserted against the
        # end-to-end row specifically: at 1.41 the dispatch-wait rows are
        # split on 8h (it clears the 338m row at 28595s and fails the 355m one
        # at 30033s), and that split moves with the queue. The end-to-end row
        # refuses 8h by 35665s (~9.9h) and refuses it for the reason the
        # threshold exists -- so it is the row worth pinning this to.
        self.assertLess(
            8 * 60 * 60,
            self.P90_MULTIPLIER * max(p90 for _, q, p90 in self.OBSERVED_WINDOWS if q == self.END_TO_END) * 60,
        )


HEAD_SHA = "a" * 40
OTHER_SHA = "b" * 40
ALLY_LOGIN = "allyblockcast[bot]"
ALLY_LOGINS = [ALLY_LOGIN, "app/allyblockcast", "allyblockcast"]


def formal_review(login=ALLY_LOGIN, commit_id=HEAD_SHA, state="COMMENTED", body=None, user_type="Bot"):
    if body is None:
        # Real Ally reviews are consolidated reports: the `## Ally ...
        # Consolidated PR Review` envelope plus the "Reviewed head: <sha>"
        # attestation line (require-ally-review.py's positively_bound
        # convention), on the formal-review surface exactly as on the comment
        # surface -- default to a consolidated body attesting whatever
        # commit_id was passed so callers that only care about
        # login/state/type don't need to spell one out every time.
        body = consolidated_body(commit_id)
    return {
        "user": {"login": login, "type": user_type},
        "commit_id": commit_id,
        "state": state,
        "body": body,
    }


def issue_comment(login=ALLY_LOGIN, body="", user_type="Bot"):
    return {"user": {"login": login, "type": user_type}, "body": body}


def consolidated_body(head_sha=HEAD_SHA):
    return (
        "## Ally -- Consolidated PR Review\n\n"
        "Reviewed head: %s\n\n"
        "### Critical Issues (0)\n### Important Issues (0)\n"
    ) % head_sha


class TestAllyHasReviewedHead(unittest.TestCase):
    def test_no_reviews_or_comments_is_not_reviewed(self):
        self.assertFalse(sweep.ally_has_reviewed_head([], [], HEAD_SHA, ALLY_LOGINS))

    def test_self_review_on_this_head_counts_as_reviewed(self):
        # The gstack/review finding on #1383: a clean self-review on an
        # App-authored PR leaves review/ally-complete permanently `pending`
        # (waiting on a distinct human) -- this must NOT read as a lost wake.
        reviews = [formal_review(commit_id=HEAD_SHA, state="COMMENTED")]
        self.assertTrue(sweep.ally_has_reviewed_head(reviews, [], HEAD_SHA, ALLY_LOGINS))

    def test_clean_commented_review_on_this_head_counts_as_reviewed(self):
        reviews = [formal_review(commit_id=HEAD_SHA, state="COMMENTED")]
        self.assertTrue(sweep.ally_has_reviewed_head(reviews, [], HEAD_SHA, ALLY_LOGINS))

    def test_review_bound_to_a_different_head_does_not_count(self):
        # commit_id and attestation both point elsewhere -- the current head
        # genuinely has no Ally signal, so this stays a re-fire candidate.
        reviews = [formal_review(commit_id=OTHER_SHA, body="Reviewed head: %s" % OTHER_SHA)]
        self.assertFalse(sweep.ally_has_reviewed_head(reviews, [], HEAD_SHA, ALLY_LOGINS))

    def test_stale_commit_id_matching_current_head_without_attestation_does_not_count(self):
        # native-codex/#1383 prior finding: commit_id is MUTABLE (frr#29 case
        # in require-ally-review.py) -- a review whose commit_id happens to
        # equal the current head, but whose body attests a DIFFERENT head it
        # actually reviewed, must NOT read as coverage for the current head.
        reviews = [formal_review(commit_id=HEAD_SHA, body="Reviewed head: %s" % OTHER_SHA)]
        self.assertFalse(sweep.ally_has_reviewed_head(reviews, [], HEAD_SHA, ALLY_LOGINS))

    def test_dismissed_review_does_not_count(self):
        reviews = [formal_review(commit_id=HEAD_SHA, state="DISMISSED")]
        self.assertFalse(sweep.ally_has_reviewed_head(reviews, [], HEAD_SHA, ALLY_LOGINS))

    def test_review_by_non_ally_login_does_not_count(self):
        reviews = [formal_review(login="some-human", commit_id=HEAD_SHA)]
        self.assertFalse(sweep.ally_has_reviewed_head(reviews, [], HEAD_SHA, ALLY_LOGINS))

    def test_review_by_ally_login_with_user_type_does_not_count(self):
        # gstack/review finding on #1383: `allyblockcast` (no `[bot]` suffix)
        # is also a real GitHub *User* account -- the maintainer identity
        # require-ally-review.py's distinct_reviewer_signals_for_head treats
        # as a genuine distinct human, not the automated App. A review from
        # that User, even attesting the right head, is not evidence the
        # automated wake landed.
        reviews = [formal_review(login="allyblockcast", commit_id=HEAD_SHA, user_type="User")]
        self.assertFalse(sweep.ally_has_reviewed_head(reviews, [], HEAD_SHA, ALLY_LOGINS))

    def test_bot_review_attesting_head_without_consolidated_envelope_does_not_count(self):
        # native-codex finding on #1383 head 8faff7cf: the formal-review path
        # used to accept a bare `Reviewed head:` line, while the comment path
        # required the consolidated envelope. A malformed or incidental Bot
        # review carrying only an attestation would therefore suppress the
        # re-fire forever, leaving review/ally-complete pending with no alarm
        # -- reinstating the BLO-22892 defect this sweep exists to fix. Both
        # surfaces must demand the consolidated report.
        reviews = [formal_review(body="Reviewed head: %s\n\nLooks fine." % HEAD_SHA)]
        self.assertFalse(sweep.ally_has_reviewed_head(reviews, [], HEAD_SHA, ALLY_LOGINS))

    def test_consolidated_formal_review_on_this_head_counts_as_reviewed(self):
        # The positive counterpart: a genuine consolidated report on the
        # formal-review surface is still coverage, so the tightening above
        # cannot make the sweep spam a head Ally really did service.
        reviews = [formal_review(body=consolidated_body(HEAD_SHA))]
        self.assertTrue(sweep.ally_has_reviewed_head(reviews, [], HEAD_SHA, ALLY_LOGINS))

    def test_consolidated_ally_comment_attesting_this_head_counts_as_reviewed(self):
        comments = [issue_comment(body=consolidated_body(HEAD_SHA))]
        self.assertTrue(sweep.ally_has_reviewed_head([], comments, HEAD_SHA, ALLY_LOGINS))

    def test_consolidated_ally_comment_attesting_a_different_head_does_not_count(self):
        comments = [issue_comment(body=consolidated_body(OTHER_SHA))]
        self.assertFalse(sweep.ally_has_reviewed_head([], comments, HEAD_SHA, ALLY_LOGINS))

    def test_non_consolidated_ally_comment_does_not_count(self):
        comments = [issue_comment(body="thanks, looking at this now")]
        self.assertFalse(sweep.ally_has_reviewed_head([], comments, HEAD_SHA, ALLY_LOGINS))

    def test_consolidated_comment_by_ally_login_with_user_type_does_not_count(self):
        comments = [issue_comment(login="allyblockcast", body=consolidated_body(HEAD_SHA), user_type="User")]
        self.assertFalse(sweep.ally_has_reviewed_head([], comments, HEAD_SHA, ALLY_LOGINS))


class TestReviewerIsAlreadyRequested(unittest.TestCase):
    def test_empty_or_missing_requested_reviewers_is_false(self):
        self.assertFalse(sweep.reviewer_is_already_requested({}, "allyblockcast"))
        self.assertFalse(sweep.reviewer_is_already_requested({"requested_reviewers": []}, "allyblockcast"))
        self.assertFalse(sweep.reviewer_is_already_requested(None, "allyblockcast"))

    def test_matching_login_is_true(self):
        pr = {"requested_reviewers": [{"login": "allyblockcast"}]}
        self.assertTrue(sweep.reviewer_is_already_requested(pr, "allyblockcast"))

    def test_match_is_case_insensitive(self):
        pr = {"requested_reviewers": [{"login": "AllyBlockcast"}]}
        self.assertTrue(sweep.reviewer_is_already_requested(pr, "allyblockcast"))

    def test_a_different_reviewer_does_not_match(self):
        pr = {"requested_reviewers": [{"login": "kkroo"}]}
        self.assertFalse(sweep.reviewer_is_already_requested(pr, "allyblockcast"))


class TestRequestReview(unittest.TestCase):
    """Pins the DELETE-before-POST ordering.

    Regression guard for BLO-22892: a bare POST for a login that is already
    an active requested reviewer returns HTTP 200 and creates no
    `review_requested` event, so the sweep reported a successful re-fire
    while delivering no reviewer wake at all. Measured against the live API
    on 2026-08-14 against PR #1383.
    """

    def setUp(self):
        self._real_request = sweep._request
        self.calls = []

    def tearDown(self):
        sweep._request = self._real_request

    def _install(self, pr_payload):
        def fake_request(url, token, method="GET", payload=None):
            self.calls.append((method, url.rsplit("/repos/", 1)[-1], payload))
            if method == "GET":
                return pr_payload
            return {}

        sweep._request = fake_request

    def methods(self):
        return [method for method, _url, _payload in self.calls]

    def test_already_requested_reviewer_is_withdrawn_before_re_requesting(self):
        self._install({"requested_reviewers": [{"login": "allyblockcast"}]})
        self.assertTrue(sweep.request_review("o", "r", 1383, "tok", "https://api.github.com"))
        # The DELETE is the whole point: without it the POST is a silent no-op.
        self.assertEqual(self.methods(), ["GET", "DELETE", "POST"])
        self.assertLess(self.methods().index("DELETE"), self.methods().index("POST"))

    def test_unrequested_reviewer_is_posted_without_a_pointless_delete(self):
        self._install({"requested_reviewers": []})
        self.assertTrue(sweep.request_review("o", "r", 1383, "tok", "https://api.github.com"))
        self.assertEqual(self.methods(), ["GET", "POST"])

    def test_reviewer_login_is_carried_on_both_calls(self):
        self._install({"requested_reviewers": [{"login": "allyblockcast"}]})
        sweep.request_review("o", "r", 1383, "tok", "https://api.github.com", login="allyblockcast")
        for method, _url, payload in self.calls:
            if method in ("DELETE", "POST"):
                self.assertEqual(payload, {"reviewers": ["allyblockcast"]})

    def test_http_error_degrades_to_false_rather_than_raising(self):
        def boom(url, token, method="GET", payload=None):
            if method == "GET":
                return {"requested_reviewers": []}
            raise urllib.error.HTTPError(url, 422, "Unprocessable", None, None)

        sweep._request = boom
        self.assertFalse(sweep.request_review("o", "r", 1383, "tok", "https://api.github.com"))

    def test_transport_error_degrades_to_false_rather_than_raising(self):
        """URLError must be swallowed exactly like HTTPError.

        HTTPError is a *subclass* of URLError, so `except HTTPError` does not
        catch a bare transport failure (DNS, timeout, connection reset). Before
        the fix that exception escaped request_review(), propagated out of
        sweep(), and aborted the run before the marker-comment fallback the
        docstring promises -- turning a transient blip into a sweep that
        reconciled nothing and left no audit trail.
        """
        def boom(url, token, method="GET", payload=None):
            if method == "GET":
                return {"requested_reviewers": []}
            raise urllib.error.URLError("dns failure")

        sweep._request = boom
        self.assertFalse(sweep.request_review("o", "r", 1383, "tok", "https://api.github.com"))

    def test_transport_error_after_withdraw_still_degrades_to_false(self):
        """The worst case: DELETE succeeded, POST died on the network.

        The PR is now left with no pending request at all -- strictly worse
        than the state we found -- so this must still return False and let
        sweep() post the marker comment as the durable trail.
        """
        def boom(url, token, method="GET", payload=None):
            if method == "GET":
                return {"requested_reviewers": [{"login": "allyblockcast"}]}
            if method == "DELETE":
                return {}
            raise urllib.error.URLError("connection reset")

        sweep._request = boom
        self.assertFalse(sweep.request_review("o", "r", 1383, "tok", "https://api.github.com"))


def _pr(number, locked=False, draft=False, sha=None):
    return {
        "number": number,
        "locked": locked,
        "draft": draft,
        "head": {"sha": sha or ("%040x" % number)},
    }


class TestSweepIsolation(unittest.TestCase):
    """sweep() must consider every open PR, whatever happens to any one of them.

    This sweep IS the reconciler for stranded PRs, so aborting the loop on a
    single failure reinstates the exact defect it exists to clear (BLO-22892)
    -- and silently, because the un-considered PRs simply never appear in the
    accounting.
    """

    def setUp(self):
        self._real_fetch = sweep._fetch_paginated
        self._real_consider = sweep._consider_pr
        self._real_refire = sweep._refire_pr
        # The re-fire pass is a separate function now, so a test that stubs
        # only _consider_pr would let a "would re-fire" verdict reach the
        # real network. Stub it by default; tests about the write override it.
        sweep._refire_pr = lambda *a, **k: None

    def tearDown(self):
        sweep._fetch_paginated = self._real_fetch
        sweep._consider_pr = self._real_consider
        sweep._refire_pr = self._real_refire

    def _install_prs(self, prs):
        def fake_fetch(api_base_url, path, token):
            if "/pulls?state=open" in path:
                return prs
            return []

        sweep._fetch_paginated = fake_fetch

    def test_locked_pr_is_skipped_without_any_further_call(self):
        """A locked conversation is a deliberate 'no automated chatter' signal.

        Skipping must happen before _consider_pr, which is what performs the
        status reads and both writes (reviewer re-request + marker comment).
        """
        self._install_prs([_pr(1, locked=True)])
        considered = []
        sweep._consider_pr = lambda *a, **k: considered.append(a) or (a[2], "", None, False, "unreachable")

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(considered, [], "locked PR must not reach _consider_pr")
        self.assertEqual(len(results), 1)
        self.assertFalse(results[0][3], "a locked PR must never be re-fired")
        self.assertIn("locked", results[0][4])

    def test_locked_pr_is_still_reported_in_the_accounting(self):
        """Skipped != invisible. The docstring promises no silent caps."""
        self._install_prs([_pr(1, locked=True), _pr(2)])
        sweep._consider_pr = lambda o, r, pr, t, u, n, **k: (pr, pr["head"]["sha"], None, False, "skip: not pending")

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual([res[0]["number"] for res in results], [1, 2])

    def test_one_failing_pr_does_not_strand_the_rest(self):
        self._install_prs([_pr(1), _pr(2), _pr(3)])

        def flaky(owner, repo, pr, token, api_base_url, now, **kwargs):
            if pr["number"] == 2:
                raise urllib.error.URLError("connection reset")
            return (pr, pr["head"]["sha"], 100.0, True, "re-fired")

        sweep._consider_pr = flaky

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual([res[0]["number"] for res in results], [1, 2, 3])
        self.assertTrue(results[0][3])
        self.assertTrue(results[2][3], "PR #3 must still be swept after #2 failed")

    def test_failed_pr_is_marked_with_the_error_prefix_not_a_clean_skip(self):
        """main() keys off this prefix to report failures separately.

        A PR we could not evaluate must not read as 'considered and fine'.
        """
        self._install_prs([_pr(1)])

        def boom(owner, repo, pr, token, api_base_url, now, **kwargs):
            raise urllib.error.URLError("dns failure")

        sweep._consider_pr = boom

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertTrue(results[0][4].startswith(sweep.SWEEP_ERROR_REASON_PREFIX))
        self.assertIsNone(results[0][2], "an unevaluated PR has no pending_since to alarm on")
        self.assertFalse(results[0][3])

    def test_rate_limit_aborts_the_loop_but_still_accounts_for_every_pr(self):
        """Budget exhaustion is not isolated per-PR -- but it is not silent either.

        Every remaining call would raise the identical error, so grinding
        through them only deepens the exhaustion. The unevaluated remainder
        must still appear in the results (as failures), or the run would
        report a short list it never finished reading.
        """
        self._install_prs([_pr(1), _pr(2), _pr(3), _pr(4)])
        attempted = []

        def limited(owner, repo, pr, token, api_base_url, now, **kwargs):
            attempted.append(pr["number"])
            if pr["number"] == 2:
                raise sweep.RateLimitExhausted("budget spent")
            return (pr, pr["head"]["sha"], None, False, "skip: not pending")

        sweep._consider_pr = limited

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(attempted, [1, 2], "must stop calling once the budget is spent")
        self.assertEqual([res[0]["number"] for res in results], [1, 2, 3, 4])
        unevaluated = [res for res in results if sweep.RATE_LIMIT_TOKEN in res[4]]
        self.assertEqual(
            [res[0]["number"] for res in unevaluated], [2, 3, 4],
            "the PR that hit the limit and every one after it are unevaluated",
        )
        for res in unevaluated:
            self.assertTrue(res[4].startswith(sweep.SWEEP_ERROR_REASON_PREFIX),
                            "rate-limited PRs must count as failures, or the run exits green")


class TestSweepIsDegraded(unittest.TestCase):
    """A run that could not evaluate its PRs must not report `alarming=0` green.

    Per-PR isolation records a failure as pending_since=None, and is_alarming
    reads None as not-alarming, so without this predicate a totally broken
    sweep and a healthy one produce the identical green tick -- the exact
    "silent failure that reads as health" defect being reconciled.
    """

    def test_no_failures_is_not_degraded(self):
        self.assertFalse(sweep.sweep_is_degraded(0, 30))
        self.assertFalse(sweep.sweep_is_degraded(0, 0))

    def test_one_transient_failure_does_not_turn_the_schedule_red(self):
        # Deliberately NOT `failed > 0`: a single 5xx against one PR is normal
        # and must not page anyone.
        self.assertFalse(sweep.sweep_is_degraded(1, 30))
        self.assertFalse(sweep.sweep_is_degraded(2, 30))

    def test_every_pr_failing_is_degraded(self):
        self.assertTrue(sweep.sweep_is_degraded(30, 30))

    def test_the_floor_protects_a_short_pr_list(self):
        # With 5 open PRs, 10% is 0.5 -- one failure would read as
        # "systematic" without the floor of 3.
        self.assertFalse(sweep.sweep_is_degraded(1, 5))
        self.assertFalse(sweep.sweep_is_degraded(2, 5))
        self.assertTrue(sweep.sweep_is_degraded(3, 5))

    def test_the_proportion_governs_a_long_pr_list(self):
        self.assertFalse(sweep.sweep_is_degraded(10, 200), "10 of 200 is under the 10% bar")
        self.assertTrue(sweep.sweep_is_degraded(20, 200))


class TestIsRateLimitError(unittest.TestCase):
    """403 is overloaded: budget exhaustion vs a permissions fault.

    Reporting a permissions 403 as a rate limit would abort the whole sweep
    on a fault that retrying can never fix, and would name the wrong cause in
    the step summary.
    """

    @staticmethod
    def _err(code, headers):
        return urllib.error.HTTPError("https://api.github.com/x", code, "nope", headers, None)

    def test_403_with_remaining_zero_is_a_rate_limit(self):
        self.assertTrue(sweep.is_rate_limit_error(self._err(403, {"x-ratelimit-remaining": "0"})))

    def test_429_with_retry_after_is_a_rate_limit(self):
        self.assertTrue(sweep.is_rate_limit_error(self._err(429, {"retry-after": "60"})))

    def test_403_permissions_fault_is_not_a_rate_limit(self):
        # "Resource not accessible by integration" carries budget headroom.
        self.assertFalse(sweep.is_rate_limit_error(self._err(403, {"x-ratelimit-remaining": "4821"})))

    def test_403_with_no_rate_headers_at_all_is_not_a_rate_limit(self):
        self.assertFalse(sweep.is_rate_limit_error(self._err(403, {})))

    def test_404_is_never_a_rate_limit(self):
        self.assertFalse(sweep.is_rate_limit_error(self._err(404, {"x-ratelimit-remaining": "0"})))


class TestRequestBoundsAndClassifies(unittest.TestCase):
    """_request is the only place every call passes through.

    Two properties are pinned here because both are invisible in normal
    operation and only bite in the failure the reconciler must survive.
    """

    def setUp(self):
        self._real_urlopen = sweep.urllib.request.urlopen

    def tearDown(self):
        sweep.urllib.request.urlopen = self._real_urlopen

    def test_every_request_carries_an_explicit_timeout(self):
        """urlopen's default is None -- block forever.

        With `cancel-in-progress: false` on the workflow, one stalled socket
        would hang the job to the Actions 6-hour ceiling and queue every
        subsequent 30-minute run behind it.
        """
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen["timeout"] = timeout
            raise urllib.error.URLError("stop here -- we only need the kwarg")

        sweep.urllib.request.urlopen = fake_urlopen
        with self.assertRaises(urllib.error.URLError):
            sweep._request("https://api.github.com/x", "tok")

        self.assertIsNotNone(seen["timeout"], "urlopen must not be called with the default (infinite) timeout")
        self.assertEqual(seen["timeout"], sweep.REQUEST_TIMEOUT_SECONDS)
        self.assertGreater(seen["timeout"], 0)

    def test_a_rate_limited_response_is_raised_as_rate_limit_exhausted(self):
        def fake_urlopen(req, timeout=None):
            raise urllib.error.HTTPError(
                "https://api.github.com/x", 403, "rate limit", {"x-ratelimit-remaining": "0"}, None
            )

        sweep.urllib.request.urlopen = fake_urlopen
        with self.assertRaises(sweep.RateLimitExhausted):
            sweep._request("https://api.github.com/x", "tok")

    def test_a_permissions_403_stays_an_http_error(self):
        """Aborting the whole sweep on a permissions fault would be wrong --
        it is not transient and it is not the budget."""
        def fake_urlopen(req, timeout=None):
            raise urllib.error.HTTPError(
                "https://api.github.com/x", 403, "not accessible", {"x-ratelimit-remaining": "4999"}, None
            )

        sweep.urllib.request.urlopen = fake_urlopen
        with self.assertRaises(urllib.error.HTTPError):
            sweep._request("https://api.github.com/x", "tok")


class TestMainExitCode(unittest.TestCase):
    """The exit code IS the deliverable (BLO-22892 AC4).

    A stranded PR and a sweep that could not run are both red, but they are
    different reds and must not be conflated: one needs a human to review a
    PR, the other means the PR list was never read.
    """

    def setUp(self):
        self._real_sweep = sweep.sweep
        self._env = {k: os.environ.get(k) for k in ("GITHUB_REPOSITORY", "GITHUB_TOKEN", "GITHUB_STEP_SUMMARY")}
        os.environ["GITHUB_REPOSITORY"] = "Blockcast/paperclip"
        os.environ["GITHUB_TOKEN"] = "t"
        os.environ.pop("GITHUB_STEP_SUMMARY", None)

    def tearDown(self):
        sweep.sweep = self._real_sweep
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _run_main_with(self, results):
        sweep.sweep = lambda *a, **k: results
        return self._run_main()

    def _run_main(self):
        # main() prints one line per PR; swallowed so a 30-PR fixture does not
        # bury the real unittest output (and so a fixture's summary line
        # cannot be misread as a real sweep's in the CI log).
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                sweep.main([])
        except SystemExit as exit_error:
            return exit_error.code
        return 0

    def test_all_prs_failing_exits_degraded_not_green(self):
        """The regression this class exists for.

        Before: failed=30 alarming=0 exited 0, so a systematically broken
        sweep was indistinguishable from a healthy one on the Actions tab.
        """
        failed = [
            (_pr(n), "%040x" % n, None, False, "%s -- HTTPError" % sweep.SWEEP_ERROR_REASON_PREFIX)
            for n in range(1, 31)
        ]
        self.assertEqual(self._run_main_with(failed), sweep.EXIT_SWEEP_DEGRADED)

    def test_a_clean_sweep_exits_zero(self):
        clean = [(_pr(n), "%040x" % n, None, False, "skip: not pending") for n in range(1, 31)]
        self.assertEqual(self._run_main_with(clean), 0)

    def test_one_transient_failure_still_exits_zero(self):
        results = [(_pr(n), "%040x" % n, None, False, "skip: not pending") for n in range(1, 31)]
        results[0] = (_pr(1), "%040x" % 1, None, False, "%s -- URLError" % sweep.SWEEP_ERROR_REASON_PREFIX)
        self.assertEqual(self._run_main_with(results), 0)

    def test_a_stranded_pr_exits_with_the_alarm_code(self):
        now = 1_000_000.0
        stranded = [(_pr(1), "%040x" % 1, now - sweep.ALARM_THRESHOLD_SECONDS - 60, False, "pending")]
        sweep.sweep = lambda *a, **k: stranded
        # main() computes `now` itself; the pending_since above is far enough
        # in the past that any nearby `now` still clears the threshold.
        stranded[0] = (_pr(1), "%040x" % 1, 0.0, False, "pending")
        self.assertEqual(self._run_main(), sweep.EXIT_ALARM)

    def test_a_stranded_pr_outranks_a_degraded_run(self):
        """Both conditions at once must report the stranded PR.

        A human can act on 'go review #N'; 'the sweep is broken' is the
        weaker instruction when a specific PR is known to be stranded.
        """
        results = [
            (_pr(n), "%040x" % n, None, False, "%s -- HTTPError" % sweep.SWEEP_ERROR_REASON_PREFIX)
            for n in range(1, 31)
        ]
        results.append((_pr(99), "%040x" % 99, 0.0, False, "pending"))
        self.assertEqual(self._run_main_with(results), sweep.EXIT_ALARM)

    def test_a_draft_pr_never_alarms_even_if_its_pending_since_is_ancient(self):
        """is_alarming reads is_draft off the payload, not a hardcoded False.

        The literal was safe only via an invariant held in _consider_pr; this
        pins the guard locally so it cannot stop guarding silently.
        """
        results = [(_pr(1, draft=True), "%040x" % 1, 0.0, False, "draft")]
        self.assertEqual(self._run_main_with(results), 0)


class TestUnreviewedSince(unittest.TestCase):
    """status-free mode dates the wait from the later of PR-open / head-commit.

    Both directions matter, so both are pinned: the max is not a tie-breaker,
    it is what keeps a long-lived branch from alarming the instant its PR
    opens, AND what stops a force-push from inheriting the old revision's age.
    """

    def test_head_commit_newer_than_pr_creation_wins(self):
        pr = {"created_at": "2026-08-01T00:00:00Z"}
        commit = {"commit": {"committer": {"date": "2026-08-10T00:00:00Z"}}}
        self.assertEqual(
            sweep.unreviewed_since(pr, commit), sweep._parse_iso("2026-08-10T00:00:00Z")
        )

    def test_pr_creation_newer_than_head_commit_wins(self):
        """A branch authored weeks ago and only now proposed for review.

        Dating from the commit would make it instantly alarming on open.
        """
        pr = {"created_at": "2026-08-10T00:00:00Z"}
        commit = {"commit": {"committer": {"date": "2026-07-01T00:00:00Z"}}}
        self.assertEqual(
            sweep.unreviewed_since(pr, commit), sweep._parse_iso("2026-08-10T00:00:00Z")
        )

    def test_missing_commit_date_falls_back_to_pr_creation(self):
        pr = {"created_at": "2026-08-10T00:00:00Z"}
        self.assertEqual(
            sweep.unreviewed_since(pr, {}), sweep._parse_iso("2026-08-10T00:00:00Z")
        )

    def test_no_parseable_timestamp_is_not_awaiting_review(self):
        """Fail closed: an undateable PR must not be re-fired, not re-fired forever."""
        self.assertIsNone(sweep.unreviewed_since({}, {}))
        self.assertIsNone(sweep.unreviewed_since({"created_at": "not-a-date"}, {}))

    def test_a_future_dated_head_commit_is_clamped_to_now(self):
        """`commit.committer.date` is client-settable and may be in the future.

        Unclamped, a skewed or rewritten date yields a NEGATIVE age that can
        never reach the stall OR alarm threshold -- the PR goes permanently
        invisible to both. That is the suppression direction this module's
        predicate bias explicitly refuses.
        """
        now = sweep._parse_iso("2026-08-10T00:00:00Z")
        pr = {"created_at": "2026-08-01T00:00:00Z"}
        skewed = {"commit": {"committer": {"date": "2027-01-01T00:00:00Z"}}}

        result = sweep.unreviewed_since(pr, skewed, now=now)

        self.assertEqual(result, now)
        self.assertGreaterEqual(now - result, 0, "age must never be negative")

    def test_a_future_dated_head_becomes_eligible_after_the_threshold_elapses(self):
        """Clamping suppresses nothing -- it only restarts the clock at now."""
        opened = sweep._parse_iso("2026-08-01T00:00:00Z")
        skewed = {"commit": {"committer": {"date": "2027-01-01T00:00:00Z"}}}
        first_seen = sweep._parse_iso("2026-08-10T00:00:00Z")

        pending_since = sweep.unreviewed_since({"created_at": "2026-08-01T00:00:00Z"}, skewed, now=first_seen)
        later = first_seen + sweep.STALL_THRESHOLD_SECONDS + 1
        refire, _reason = sweep.should_refire(
            {"number": 1, "is_draft": False, "pending_since": pending_since, "existing_marker_epochs": []},
            later,
        )

        self.assertLess(opened, first_seen)
        self.assertTrue(refire, "a future-dated head must still become eligible with real elapsed time")

    def test_a_future_dated_pr_creation_is_clamped_too(self):
        now = sweep._parse_iso("2026-08-10T00:00:00Z")
        self.assertEqual(sweep.unreviewed_since({"created_at": "2027-01-01T00:00:00Z"}, {}, now=now), now)


class TestTooYoungToBeStranded(unittest.TestCase):
    """The list payload alone can prove a PR needs no per-PR fetches.

    This is a call-volume guard, not a correctness one: at ~3 requests per
    non-draft PR and 108 of them, the sweep runs at ~700 requests/hour
    against github.token's 1,000/hour/repository budget, shared with every
    other workflow. It must never change a verdict, only skip work that
    cannot change one.
    """

    def setUp(self):
        self._real_mode = sweep.PREDICATE_MODE
        sweep.PREDICATE_MODE = "status-free"

    def tearDown(self):
        sweep.PREDICATE_MODE = self._real_mode

    def test_a_pr_opened_within_the_threshold_is_too_young(self):
        now = sweep._parse_iso("2026-08-10T00:00:00Z")
        pr = {"created_at": "2026-08-09T23:30:00Z"}  # 30 minutes < 90m stall
        self.assertTrue(sweep.too_young_to_be_stranded(pr, now))

    def test_an_older_pr_must_still_be_fetched(self):
        now = sweep._parse_iso("2026-08-10T00:00:00Z")
        pr = {"created_at": "2026-08-01T00:00:00Z"}
        self.assertFalse(sweep.too_young_to_be_stranded(pr, now))

    def test_the_filter_is_sound_because_pending_since_is_bounded_below_by_created_at(self):
        """The proof the shortcut rests on, pinned as a test.

        unreviewed_since returns max(created_at, committer_date) clamped to
        now, so pending_since >= created_at for every input -- hence
        now - pending_since <= now - created_at, and a PR younger than the
        stall threshold cannot clear it however old its head commit claims
        to be.
        """
        now = sweep._parse_iso("2026-08-10T00:00:00Z")
        pr = {"created_at": "2026-08-09T23:30:00Z"}
        for commit_date in ("2020-01-01T00:00:00Z", "2026-08-09T23:59:00Z", "2027-01-01T00:00:00Z"):
            pending_since = sweep.unreviewed_since(pr, {"commit": {"committer": {"date": commit_date}}}, now=now)
            self.assertGreaterEqual(pending_since, sweep._parse_iso(pr["created_at"]))
            self.assertLess(now - pending_since, sweep.STALL_THRESHOLD_SECONDS)

    def test_status_mode_never_uses_the_shortcut(self):
        """In status mode pending_since comes from a commit status, which is
        NOT bounded below by the PR's creation date, so the inequality the
        filter rests on does not hold and it would be unsound."""
        sweep.PREDICATE_MODE = "status"
        now = sweep._parse_iso("2026-08-10T00:00:00Z")
        self.assertFalse(sweep.too_young_to_be_stranded({"created_at": "2026-08-09T23:59:00Z"}, now))

    def test_an_unparseable_creation_date_is_never_shortcut(self):
        now = sweep._parse_iso("2026-08-10T00:00:00Z")
        self.assertFalse(sweep.too_young_to_be_stranded({"created_at": "not-a-date"}, now))
        self.assertFalse(sweep.too_young_to_be_stranded({}, now))


class TestRefireBudget(unittest.TestCase):
    """MAX_REFIRES_PER_RUN throttles writes without hiding stranded PRs."""

    def setUp(self):
        self._real_fetch = sweep._fetch_paginated
        self._real_consider = sweep._consider_pr
        self._real_refire = sweep._refire_pr
        self._real_permitted = sweep.refire_still_permitted
        self._real_max = sweep.MAX_REFIRES_PER_RUN
        self._real_max_attempts = sweep.MAX_REFIRE_ATTEMPTS_PER_RUN
        self.refired = []
        sweep._refire_pr = lambda o, r, pr, h, p, t, u, n: self.refired.append(pr["number"])

    def tearDown(self):
        sweep._fetch_paginated = self._real_fetch
        sweep._consider_pr = self._real_consider
        sweep._refire_pr = self._real_refire
        sweep.refire_still_permitted = self._real_permitted
        sweep.MAX_REFIRES_PER_RUN = self._real_max
        sweep.MAX_REFIRE_ATTEMPTS_PER_RUN = self._real_max_attempts

    def _guard(self, withhold=(), fail=()):
        """Stub the pre-write re-check; record which PRs it was asked about.

        `withhold` ANSWERS (not permitted) -- the guard worked. `fail` RAISES
        -- the guard could not be evaluated. The two spend different budgets,
        which is the distinction these tests exist to pin.
        """
        self.rechecked = []

        def fake_permitted(owner, repo, number, head_sha, token, api_base_url, now):
            self.rechecked.append(number)
            if number in fail:
                raise sweep.RateLimitExhausted("exhausted")
            if number in withhold:
                return (False, "already re-asked", sweep.REREAD_SKIP_REASON_PREFIX)
            return (True, None, None)

        sweep.refire_still_permitted = fake_permitted

    def _install_prs(self, prs):
        def fake_fetch(api_base_url, path, token):
            return prs if "/pulls?state=open" in path else []

        sweep._fetch_paginated = fake_fetch

    def _eligible_at(self, ages):
        """Stub _consider_pr so PR n is eligible with pending_since ages[n]."""
        def fake_consider(o, r, pr, t, u, n):
            return (pr, pr["head"]["sha"], ages[pr["number"]], True, "re-fired")

        sweep._consider_pr = fake_consider

    def test_over_budget_prs_are_deferred_not_dropped(self):
        sweep.MAX_REFIRES_PER_RUN = 2
        self._install_prs([_pr(1), _pr(2), _pr(3), _pr(4)])
        seen = []

        def fake_consider(o, r, pr, t, u, n):
            seen.append(pr["number"])
            return (pr, pr["head"]["sha"], 100.0, True, "re-fired")

        sweep._consider_pr = fake_consider
        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(seen, [1, 2, 3, 4], "every PR is still evaluated")
        self.assertEqual(len(results), 4, "deferred PRs stay in the accounting")
        self.assertEqual(len(self.refired), 2, "the cap still bounds the writes")
        deferred = [r for r in results if str(r[4]).startswith(sweep.DEFERRED_REASON_PREFIX)]
        self.assertEqual(len(deferred), 2)

    def test_budget_goes_to_the_longest_waiting_not_to_list_order(self):
        """PEN-3394 regression.

        `GET /pulls?state=open` returns NEWEST FIRST, and the budget used to
        be spent while walking that list -- so the newest eligible PRs took
        every slot and the oldest never got one. Measured on paperclip over
        five consecutive runs: in every one, every re-fired PR number was
        strictly greater than every deferred number. #1862 went 50h with no
        re-fire while newer PRs were re-fired hourly.

        List order here is newest-first (4, 3, 2, 1) while the waits run the
        other way, so a regression to positional spending re-fires {4, 3}.
        """
        sweep.MAX_REFIRES_PER_RUN = 2
        self._install_prs([_pr(4), _pr(3), _pr(2), _pr(1)])
        self._eligible_at({1: 100.0, 2: 200.0, 3: 300.0, 4: 400.0})

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(sorted(self.refired), [1, 2], "longest-waiting two win the budget")
        self.assertEqual(
            sorted(r[0]["number"] for r in results
                   if str(r[4]).startswith(sweep.DEFERRED_REASON_PREFIX)),
            [3, 4],
        )
        self.assertEqual(
            [r[0]["number"] for r in results], [4, 3, 2, 1],
            "the accounting still reports in list order, unsorted",
        )

    def test_a_failed_refire_does_not_strand_the_remaining_refires(self):
        sweep.MAX_REFIRES_PER_RUN = 3
        self._install_prs([_pr(1), _pr(2), _pr(3)])
        self._eligible_at({1: 100.0, 2: 200.0, 3: 300.0})
        attempted = []

        def flaky_refire(o, r, pr, h, p, t, u, n):
            attempted.append(pr["number"])
            if pr["number"] == 2:
                raise urllib.error.URLError("connection reset")

        sweep._refire_pr = flaky_refire
        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(attempted, [1, 2, 3], "#3 is still attempted after #2 failed")
        by_number = {r[0]["number"]: r for r in results}
        self.assertTrue(by_number[1][3])
        self.assertTrue(by_number[3][3])
        self.assertFalse(by_number[2][3], "a failed write must not read as re-fired")
        self.assertTrue(
            str(by_number[2][4]).startswith(sweep.SWEEP_ERROR_REASON_PREFIX),
            "and must not read as a clean skip either",
        )

    def test_a_failed_refire_does_not_consume_a_budget_slot(self):
        """PEN-3394 review regression.

        A failed write posts no marker, so should_refire's cooldown never
        engages: the PR keeps the longest wait and sorts back to rank 0 on
        the next run, forever. If that failure spent a slot, then
        MAX_REFIRES_PER_RUN permanently-failing PRs would consume the whole
        budget every run and nobody would be served -- the same starvation
        this change exists to fix, through a different door.

        #1 waits longest and always fails. Against attempt-counting this
        re-fires only {2}; the budget must instead fall through to {2, 3}.
        """
        sweep.MAX_REFIRES_PER_RUN = 2
        self._install_prs([_pr(1), _pr(2), _pr(3), _pr(4)])
        self._eligible_at({1: 100.0, 2: 200.0, 3: 300.0, 4: 400.0})
        attempted = []

        def always_fails_on_1(o, r, pr, h, p, t, u, n):
            attempted.append(pr["number"])
            if pr["number"] == 1:
                raise urllib.error.HTTPError(
                    "u", 403, "resource not accessible by integration", {}, None
                )
            self.refired.append(pr["number"])

        sweep._refire_pr = always_fails_on_1
        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(attempted, [1, 2, 3], "the failure falls through to the next-ranked PR")
        self.assertEqual(self.refired, [2, 3], "a full budget is still DELIVERED")
        by_number = {r[0]["number"]: r for r in results}
        self.assertFalse(by_number[1][3], "the failed write must not read as re-fired")
        self.assertIn(sweep.REFIRE_WRITE_FAILURE_TOKEN, str(by_number[1][4]))
        self.assertTrue(
            str(by_number[4][4]).startswith(sweep.DEFERRED_REASON_PREFIX),
            "#4 is deferred because the budget was delivered, not because it was burnt",
        )

    def test_the_attempt_ceiling_bounds_the_fall_through(self):
        """Counting successes must not let a run of failures walk the whole set.

        Every write fails here, so nothing ever consumes the delivery cap.
        MAX_REFIRE_ATTEMPTS_PER_RUN is the only thing that stops the loop.
        """
        sweep.MAX_REFIRES_PER_RUN = 5
        sweep.MAX_REFIRE_ATTEMPTS_PER_RUN = 2
        self._install_prs([_pr(1), _pr(2), _pr(3), _pr(4)])
        self._eligible_at({1: 100.0, 2: 200.0, 3: 300.0, 4: 400.0})
        attempted = []

        def always_fails(o, r, pr, h, p, t, u, n):
            attempted.append(pr["number"])
            raise urllib.error.URLError("connection reset")

        sweep._refire_pr = always_fails
        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(attempted, [1, 2], "the attempt ceiling caps the API calls")
        deferred = [r for r in results if str(r[4]).startswith(sweep.DEFERRED_REASON_PREFIX)]
        self.assertEqual(sorted(r[0]["number"] for r in deferred), [3, 4])
        self.assertIn(
            "MAX_REFIRE_ATTEMPTS_PER_RUN", str(deferred[0][4]),
            "the deferral must name the ceiling that actually bit, not the delivery cap",
        )
        for res in deferred:
            self.assertIsNotNone(res[2], "a deferred PR keeps pending_since so it can still ALARM")

    def test_a_guard_withheld_write_does_not_consume_a_delivery_slot(self):
        """PEN-3394 review regression -- replaces a test that could not fail.

        The contract at the withheld branch is that a guard-ANSWERED skip
        "spends neither `succeeded` nor `attempted`: the slot stays free for
        the next ranked PR." The prior test drove ONE fixture PR against the
        default cap of 5 and asserted only that it did not read as re-fired.
        With four spare slots, spending one was unobservable: inserting the
        exact inverse of the contract (`attempted += 1; succeeded += 1`) into
        that branch left the whole suite green.

        Two PRs and a cap of ONE make it observable. #1 waits longest and is
        withheld by the guard; if that consumed the only slot, #2 is deferred
        and nothing is delivered at all.
        """
        sweep.MAX_REFIRES_PER_RUN = 1
        self._install_prs([_pr(1), _pr(2)])
        self._eligible_at({1: 100.0, 2: 200.0})
        self._guard(withhold=(1,))

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(self.rechecked, [1, 2], "both are re-checked in rank order")
        self.assertEqual(
            self.refired, [2],
            "the withheld PR left the slot free, so the next-ranked PR is DELIVERED",
        )
        by_number = {r[0]["number"]: r for r in results}
        self.assertFalse(by_number[1][3], "a withheld write must not read as a re-fire")
        self.assertTrue(
            str(by_number[1][4]).startswith(sweep.REREAD_SKIP_REASON_PREFIX),
            "a guard that ANSWERED is a clean skip, not a sweep error",
        )
        self.assertFalse(
            str(by_number[2][4]).startswith(sweep.DEFERRED_REASON_PREFIX),
            "#2 must not be deferred -- the budget was never spent on #1",
        )

    def test_a_guard_withheld_write_does_not_consume_an_attempt_slot(self):
        """The same contract against the OTHER ceiling.

        `succeeded` and `attempted` are separate counters and the withheld
        branch must spend neither, so pinning only the delivery cap above
        would leave half the invariant unobserved.
        """
        sweep.MAX_REFIRES_PER_RUN = 5
        sweep.MAX_REFIRE_ATTEMPTS_PER_RUN = 1
        self._install_prs([_pr(1), _pr(2)])
        self._eligible_at({1: 100.0, 2: 200.0})
        self._guard(withhold=(1,))

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(
            self.refired, [2],
            "a withheld write spends no attempt, so #2 still wins the only one",
        )
        self.assertEqual(
            [r for r in results if str(r[4]).startswith(sweep.DEFERRED_REASON_PREFIX)], [],
            "nothing is deferred: the single attempt was never consumed by #1",
        )

    def test_a_failing_pre_write_recheck_cannot_walk_the_entire_eligible_set(self):
        """PEN-3394 review regression.

        A guard that ANSWERS is free; a guard that FAILS is not. Its failure
        branch issues live reads and then `continue`s, and it used to reach
        neither counter -- so after pass 1's rate-limit break, when every
        later read raises, pass 2 walked every eligible PR making doomed
        reads. Measured at 90 eligible PRs: 90 re-check calls, 0 deferred,
        directly falsifying the bound asserted in the comment above the loop.

        Pass 1 `break`s rather than grinding out N indistinguishable per-PR
        failures precisely because that deepens the exhaustion it reacts to;
        pass 2 then did exactly that.
        """
        sweep.MAX_REFIRES_PER_RUN = 5
        sweep.MAX_REFIRE_ATTEMPTS_PER_RUN = 2
        self._install_prs([_pr(1), _pr(2), _pr(3), _pr(4)])
        self._eligible_at({1: 100.0, 2: 200.0, 3: 300.0, 4: 400.0})
        self._guard(fail=(1, 2, 3, 4))

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(
            self.rechecked, [1, 2],
            "the attempt ceiling bounds the re-check reads, not just the writes",
        )
        self.assertEqual(self.refired, [], "no write can land when the guard never permits one")
        by_number = {r[0]["number"]: r for r in results}
        for number in (1, 2):
            self.assertIn(sweep.REFIRE_RECHECK_FAILURE_TOKEN, str(by_number[number][4]))
            self.assertNotIn(
                sweep.REFIRE_WRITE_FAILURE_TOKEN, str(by_number[number][4]),
                "a re-check failure is not a failed write",
            )
        deferred = [r for r in results if str(r[4]).startswith(sweep.DEFERRED_REASON_PREFIX)]
        self.assertEqual(
            sorted(r[0]["number"] for r in deferred), [3, 4],
            "the PRs past the ceiling are DEFERRED, not silently walked",
        )
        self.assertIn(
            "2 pre-write re-check(s) failed", str(deferred[0][4]),
            "the deferral names the cause that actually spent the ceiling",
        )
        self.assertIn(
            "0 re-fire write(s) failed", str(deferred[0][4]),
            "and must not attribute the spend to writes that never happened",
        )
        for res in deferred:
            self.assertIsNotNone(res[2], "a deferred PR keeps pending_since so it can still ALARM")

    def test_a_transient_recheck_failure_still_falls_through_to_the_next_pr(self):
        """Isolation is preserved -- the ceiling bounds, it does not abort.

        Counting re-check failures must not become a whole-loop `break`: a
        single transient failure at rank 0 has to cost one slot, not strand
        every longer-waiting PR below it. That whole-loop abort is precisely
        what the decision pass refuses and what this row exists to fix.
        """
        sweep.MAX_REFIRES_PER_RUN = 5
        sweep.MAX_REFIRE_ATTEMPTS_PER_RUN = 10
        self._install_prs([_pr(1), _pr(2), _pr(3)])
        self._eligible_at({1: 100.0, 2: 200.0, 3: 300.0})
        self._guard(fail=(1,))

        sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(self.rechecked, [1, 2, 3], "rank 0 failing does not abort the pass")
        self.assertEqual(
            self.refired, [2, 3],
            "the lower-ranked PRs are still served after a transient guard failure",
        )

    def test_rate_limit_in_the_read_pass_still_spends_the_refire_budget(self):
        """PEN-3394: the read pass `break`s into pass 2 rather than returning.

        Under the old single pass, PRs walked before exhaustion had ALREADY
        been written. Now the writes all happen in pass 2, so a `return` here
        would make an exhausted run issue ZERO re-fires -- and worse, leave
        the already-decided PRs at refire=True with no write attempted, so
        main()'s `refired = [r for r in results if r[3]]` would report
        re-fires that never occurred.

        The pre-existing rate-limit test cannot catch that: it returns
        refire=False for every PR, so pass 2 finds an empty eligible set and
        passes identically against `return` and against `break`. This one
        makes #1 eligible before #2 exhausts the budget.
        """
        self._install_prs([_pr(1), _pr(2), _pr(3)])
        considered = []

        def limited(o, r, pr, t, u, n):
            considered.append(pr["number"])
            if pr["number"] == 2:
                raise sweep.RateLimitExhausted("budget spent")
            return (pr, pr["head"]["sha"], 100.0, True, "re-fired")

        sweep._consider_pr = limited
        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertEqual(considered, [1, 2], "the READ pass still aborts")
        self.assertEqual(
            self.refired, [1],
            "but the decided PR is still written -- the re-asks are the product",
        )
        by_number = {r[0]["number"]: r for r in results}
        self.assertTrue(by_number[1][3], "and it reports as re-fired because it was")
        for n in (2, 3):
            self.assertIn(sweep.RATE_LIMIT_TOKEN, str(by_number[n][4]))
            self.assertFalse(by_number[n][3], "unevaluated PRs must not report phantom re-fires")

    def test_deferred_pr_still_carries_pending_since_so_it_can_alarm(self):
        """Rate-limiting a write must never suppress the alarm.

        A deferred PR is stranded work; if the cap silenced is_alarming() the
        sweep would go green while PRs rot -- the BLO-22892 defect one layer up.
        """
        sweep.MAX_REFIRES_PER_RUN = 0
        self._install_prs([_pr(1)])
        self._eligible_at({1: 100.0})

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertTrue(str(results[0][4]).startswith(sweep.DEFERRED_REASON_PREFIX))
        self.assertIsNotNone(results[0][2])
        self.assertTrue(
            sweep.is_alarming({"is_draft": False, "pending_since": results[0][2]},
                              100.0 + sweep.ALARM_THRESHOLD_SECONDS)
        )

    def test_write_failed_pr_still_carries_pending_since_so_it_can_alarm(self):
        """The write-side twin of the deferred test above; BLO-22892 class.

        A rejected write must not drop pending_since: the PR was read in
        full, so its alarm verdict is exact, and sweep_is_degraded's floor
        of max(3, 10%) does not backstop a few write failures on a large
        open-PR list.
        """
        sweep.MAX_REFIRES_PER_RUN = 1
        self._install_prs([_pr(1)])
        self._eligible_at({1: 100.0})

        def failing_refire(*args):
            raise RuntimeError("boom")

        sweep._refire_pr = failing_refire

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=0.0)

        self.assertTrue(str(results[0][4]).startswith(sweep.SWEEP_ERROR_REASON_PREFIX))
        self.assertIn(sweep.REFIRE_WRITE_FAILURE_TOKEN, str(results[0][4]))
        self.assertIsNotNone(results[0][2])
        self.assertTrue(
            sweep.is_alarming({"is_draft": False, "pending_since": results[0][2]},
                              100.0 + sweep.ALARM_THRESHOLD_SECONDS)
        )


class TestDryRun(unittest.TestCase):
    """--dry-run must report the real plan and issue no writes."""

    def setUp(self):
        self._real_request = sweep._request
        self._real_fetch = sweep._fetch_paginated

    def tearDown(self):
        sweep._request = self._real_request
        sweep._fetch_paginated = self._real_fetch

    def test_dry_run_reports_would_refire_without_calling_request(self):
        calls = []

        def fake_request(url, token, method="GET", payload=None):
            calls.append((method, url))
            return {}

        def fake_fetch(api_base_url, path, token):
            if "/pulls?state=open" in path:
                return [_pr(1)]
            if "/statuses" in path:
                return [status("pending", "2026-08-01T00:00:00Z")]
            return []

        sweep._request = fake_request
        sweep._fetch_paginated = fake_fetch
        # Key off the constant, not a literal: a hardcoded age silently turns
        # into a "not yet stalled" case the next time the threshold is
        # recalibrated upward, and the test then fails for a reason that has
        # nothing to do with dry-run behaviour.
        now = sweep._parse_iso("2026-08-01T00:00:00Z") + sweep.STALL_THRESHOLD_SECONDS + HOUR

        results = sweep.sweep("o", "r", "tok", "https://api.github.com", now=now, dry_run=True)

        self.assertTrue(results[0][3], "the plan still reports a re-fire")
        self.assertIn("DRY-RUN", results[0][4])
        self.assertEqual(
            [c for c in calls if c[0] != "GET"], [],
            "a dry run must issue no POST/DELETE",
        )


class TestCommentBodyIsModeAware(unittest.TestCase):
    def test_status_mode_names_the_check(self):
        body = sweep.build_comment_body(7, "a" * 40, 3 * HOUR, requested_login="allyblockcast", mode="status")
        self.assertIn(sweep.STATUS_CONTEXT, body)
        self.assertTrue(body.startswith(sweep.MARKER))

    def test_status_free_mode_does_not_claim_a_check_that_does_not_exist(self):
        """paperclip has no review/ally-complete producer at all.

        Asserting a pending check there would send a reader to a Checks tab
        that has never carried that context.
        """
        body = sweep.build_comment_body(7, "b" * 40, 3 * HOUR, requested_login="allyblockcast", mode="status-free")
        self.assertNotIn(sweep.STATUS_CONTEXT, body)
        self.assertIn("awaiting review", body)


class TestCooldownArithmeticIsShared(unittest.TestCase):
    """cooldown_blocks_refire is the single definition of the cooldown.

    should_refire (scan) and refire_still_permitted (pre-write re-read) both
    call it. A second copy would be free to drift, and a guard that disagreed
    with the decision it guards would be worse than no guard at all.
    """

    def test_no_markers_never_blocks(self):
        blocked, reason = sweep.cooldown_blocks_refire([], 0.0)
        self.assertFalse(blocked)
        self.assertIsNone(reason)

    def test_marker_inside_the_cooldown_blocks_and_says_why(self):
        now = 10 * HOUR
        blocked, reason = sweep.cooldown_blocks_refire([now - 60.0], now)
        self.assertTrue(blocked)
        self.assertIn("cooldown", reason)

    def test_marker_outside_the_cooldown_does_not_block(self):
        now = 10 * HOUR
        blocked, _ = sweep.cooldown_blocks_refire([now - (sweep.REFIRE_COOLDOWN_SECONDS + 1)], now)
        self.assertFalse(blocked)

    def test_the_newest_marker_wins_not_the_oldest(self):
        """An old marker must not license a re-fire when a recent one exists."""
        now = 10 * HOUR
        epochs = [now - 5 * HOUR, now - 30.0, now - 4 * HOUR]
        blocked, _ = sweep.cooldown_blocks_refire(epochs, now)
        self.assertTrue(blocked)

    def test_marker_epochs_are_extracted_by_prefix_only(self):
        comments = [
            {"body": sweep.MARKER + "\n@ally please re-review", "created_at": "2026-09-01T00:00:00Z"},
            {"body": "an ordinary human comment", "created_at": "2026-09-01T01:00:00Z"},
            {"body": None, "created_at": "2026-09-01T02:00:00Z"},
            {"body": "prose that merely mentions " + sweep.MARKER, "created_at": "2026-09-01T03:00:00Z"},
        ]
        epochs = sweep.marker_epochs_from_comments(comments)
        self.assertEqual(epochs, [sweep._parse_iso("2026-09-01T00:00:00Z")])


class TestPreWriteRereadGuard(unittest.TestCase):
    """BLO-31908: the re-fire cooldown was check-then-act.

    The markers are read during the scan and the write happens later with no
    re-read, so two sweeps executing concurrently both observed
    `since_last >= REFIRE_COOLDOWN_SECONDS` and both fired. That is worse than
    a duplicate comment: request_review DELETEs before it POSTs, so
    `A-DELETE / A-POST / B-DELETE / B-POST` also leaves a window in which the
    PR carries no pending review request at all.

    The race is not reproducible against live GitHub on demand -- it needs a
    runner-starvation backlog released together -- so these tests ARE the
    acceptance evidence. They simulate the interleaving by returning different
    comment pages to the scan read and to the pre-write re-read.
    """

    def setUp(self):
        self._real_request = sweep._request
        self._real_fetch = sweep._fetch_paginated
        self.calls = []
        self.comment_pages = []
        self.comment_fetches = 0

    def tearDown(self):
        sweep._request = self._real_request
        sweep._fetch_paginated = self._real_fetch

    def _install(self, scan_comments, reread_comments, already_requested=True):
        """Serve `scan_comments` to the scan read and `reread_comments` to the
        pre-write re-read -- i.e. a marker that landed in between."""
        self.comment_pages = [scan_comments, reread_comments]

        def fake_fetch(api_base_url, path, token):
            if "/pulls?state=open" in path:
                return [_pr(1)]
            if "/statuses" in path:
                return [status("pending", PENDING_SINCE)]
            if "/comments" in path:
                index = min(self.comment_fetches, len(self.comment_pages) - 1)
                self.comment_fetches += 1
                return self.comment_pages[index]
            return []

        def fake_request(url, token, method="GET", payload=None):
            self.calls.append((method, url))
            if method == "GET":
                return {
                    "requested_reviewers": [{"login": "allyblockcast"}] if already_requested else []
                }
            return {}

        sweep._fetch_paginated = fake_fetch
        sweep._request = fake_request

    def _consider(self, may_refire=True, dry_run=False):
        """Drive the single fixture PR through the real sweep() and return its
        outcome 5-tuple.

        These tests used to call _consider_pr directly, because the write --
        and therefore the pre-write guard -- lived inside it. PEN-3394 split
        the decision pass out, so _consider_pr now issues no writes and the
        guard runs in sweep()'s WRITE pass, alongside the write it protects.
        Driving _consider_pr here would no longer exercise the guard AT ALL,
        and every assertion below would pass vacuously against a sweep that
        had stopped re-checking entirely.

        Same fixture, same returned tuple, so the assertions are unchanged.
        `may_refire=False` is expressed the way sweep() now expresses it -- an
        exhausted delivery budget, which is what that flag encoded.
        """
        real_cap = sweep.MAX_REFIRES_PER_RUN
        if not may_refire:
            sweep.MAX_REFIRES_PER_RUN = 0
        try:
            results = sweep.sweep(
                "o", "r", "tok", "https://api.github.com", now=self._now(), dry_run=dry_run
            )
        finally:
            sweep.MAX_REFIRES_PER_RUN = real_cap
        return results[0]

    def _now(self):
        # Past STALL_THRESHOLD_SECONDS by a margin whatever it is calibrated to
        # today, so should_refire says yes on the scan and only the guard can
        # stop the write.
        return sweep._parse_iso(PENDING_SINCE) + sweep.STALL_THRESHOLD_SECONDS + HOUR

    def _marker(self, at):
        return [{"body": sweep.MARKER + "\nre-ask", "created_at": at}]

    def _writes(self):
        return [(method, url) for method, url in self.calls if method != "GET"]

    def test_marker_landing_between_scan_and_write_withholds_the_refire(self):
        """The headline case: a concurrent sweep posted a marker mid-run."""
        now = self._now()
        self._install(scan_comments=[], reread_comments=self._marker(_iso(self._now() - 60)))

        pr, _head, _pending, refire, reason = self._consider()

        self.assertFalse(refire, "the guard must decline once the cooldown no longer permits")
        self.assertTrue(reason.startswith(sweep.REREAD_SKIP_REASON_PREFIX), reason)
        self.assertEqual(self._writes(), [], "no DELETE and no POST may be issued")

    def test_both_writes_are_withheld_not_just_the_review_request(self):
        """Gating only request_review would leave half the defect in place.

        The marker comment is what the cooldown is derived from, so posting it
        alone would still double the re-ask trail and push the cooldown out for
        the next run.
        """
        now = self._now()
        self._install(scan_comments=[], reread_comments=self._marker(_iso(self._now() - 60)))

        self._consider()

        self.assertEqual(
            [url for _m, url in self.calls if "/issues/" in url and "comments" in url],
            [],
            "the marker comment POST must be withheld too",
        )

    def test_unchanged_markers_still_permit_the_write(self):
        """Negative control.

        Without this, the test above would pass just as happily if the guard
        broke the write path outright and the sweep never re-fired anything.
        """
        now = self._now()
        self._install(scan_comments=[], reread_comments=[])

        _pr_payload, _head, _pending, refire, _reason = self._consider()

        self.assertTrue(refire)
        methods = [method for method, _url in self.calls]
        self.assertIn("DELETE", methods)
        self.assertIn("POST", methods)
        # Keyed on URLs rather than the bare method sequence, which cannot tell
        # the marker-comment POST apart from the requested_reviewers POST --
        # and since the marker is now written FIRST (PEN-3394 review), a bare
        # `methods.index("POST")` finds the comment and the old
        # DELETE-before-POST assertion stopped meaning what it said.
        writes = [(m, u) for m, u in self.calls if m in ("POST", "DELETE")]
        comment_post = next(
            i for i, (m, u) in enumerate(writes)
            if m == "POST" and "/issues/" in u and "comments" in u
        )
        reviewer_delete = next(
            i for i, (m, u) in enumerate(writes) if m == "DELETE" and "requested_reviewers" in u
        )
        reviewer_post = next(
            i for i, (m, u) in enumerate(writes) if m == "POST" and "requested_reviewers" in u
        )
        self.assertLess(
            comment_post, reviewer_delete,
            "the marker comment is the cooldown's only token and must be the FIRST write",
        )
        self.assertLess(
            reviewer_delete, reviewer_post,
            "request_review must withdraw an existing request before re-issuing it",
        )

    def test_a_marker_older_than_the_cooldown_does_not_block(self):
        """The guard re-applies the cooldown, it does not veto on any marker.

        A stale marker is exactly the state a legitimate re-fire starts from,
        so treating any marker as blocking would wedge the sweep permanently.
        """
        now = self._now()
        stale = self._marker(_iso(self._now() - 3 * sweep.REFIRE_COOLDOWN_SECONDS))  # 3 cooldowns before now
        self._install(scan_comments=stale, reread_comments=stale)

        _pr_payload, _head, _pending, refire, _reason = self._consider()

        self.assertTrue(refire)
        self.assertNotEqual(self._writes(), [])

    def test_the_guard_reads_comments_again_rather_than_trusting_the_scan(self):
        """Pins the extra read itself.

        If a later refactor were to reuse the scan's comment list, every test
        above would still pass while the race was fully reopened -- the guard
        would be re-checking the very data whose staleness is the defect.
        """
        now = self._now()
        self._install(scan_comments=[], reread_comments=[])

        self._consider()

        self.assertGreaterEqual(
            self.comment_fetches, 2,
            "the write path must issue a fresh comments read, not reuse the scan's",
        )

    def test_a_failed_reread_withholds_the_write_rather_than_writing_blind(self):
        """Fail-closed, and loudly.

        request_review swallows its own transport failures because the marker
        comment is still a durable trail. The guard must NOT: if it cannot be
        evaluated, the safe direction is to withhold the write and let sweep()
        isolate and report the PR.

        PEN-3394 note: the guard now runs inside sweep()'s write pass, so
        "let sweep() isolate it" is literal rather than delegated -- the
        exception is caught at the call site instead of propagating out of
        _consider_pr. That isolation is load-bearing here: an escaping guard
        failure would abort pass 2 and strand every LOWER-RANKED PR, i.e.
        exactly the longest-waiting ones this change exists to serve. What
        must not change is the direction of the failure: withhold, and record
        it as an error rather than a clean skip.
        """
        now = self._now()
        self._install(scan_comments=[], reread_comments=[])
        real_fetch = sweep._fetch_paginated

        def fetch_then_die(api_base_url, path, token):
            if "/comments" in path and self.comment_fetches >= 1:
                raise urllib.error.URLError("connection reset")
            return real_fetch(api_base_url, path, token)

        sweep._fetch_paginated = fetch_then_die

        _pr_payload, _head, pending_since, refire, reason = self._consider()

        self.assertEqual(self._writes(), [], "a guard that cannot be evaluated must not write")
        self.assertFalse(refire, "a withheld write must not read as a re-fire")
        self.assertTrue(
            reason.startswith(sweep.SWEEP_ERROR_REASON_PREFIX),
            "an unevaluable guard is an ERROR, not a clean skip -- it must count "
            "toward sweep_is_degraded rather than passing as a healthy run: %s" % reason,
        )
        self.assertIn(sweep.REFIRE_RECHECK_FAILURE_TOKEN, reason)
        self.assertNotIn(
            sweep.REFIRE_WRITE_FAILURE_TOKEN, reason,
            "a re-check failure is not a failed write -- main() reports the two separately",
        )
        self.assertIsNotNone(
            pending_since,
            "the PR is still stranded, so it must keep pending_since and stay able to ALARM",
        )

    def test_the_guard_is_not_consulted_when_the_budget_is_already_spent(self):
        """Deferred PRs are not going to be written, so do not spend a request.

        Call volume is the binding constraint on this job.
        """
        now = self._now()
        self._install(scan_comments=[], reread_comments=[])

        _pr_payload, _head, _pending, refire, reason = self._consider(may_refire=False)

        self.assertFalse(refire)
        self.assertTrue(reason.startswith(sweep.DEFERRED_REASON_PREFIX))
        self.assertEqual(self.comment_fetches, 1, "only the scan read, no guard read")

    def test_dry_run_issues_no_guard_read_and_no_writes(self):
        now = self._now()
        self._install(scan_comments=[], reread_comments=[])

        _pr_payload, _head, _pending, refire, reason = self._consider(dry_run=True)

        self.assertTrue(refire, "the plan still reports what a live run would do")
        self.assertIn("DRY-RUN", reason)
        self.assertEqual(self._writes(), [])
        self.assertEqual(self.comment_fetches, 1, "only the scan read, no guard read")


class TestPreWriteAllyReviewedGuard(unittest.TestCase):
    """BLO-32044: the pre-write guard re-applied the cooldown but not
    ally_has_reviewed_head, so it could re-ask for a review that just landed.

    The scan has TWO preconditions -- the cooldown, and "Ally has not reviewed
    this head". BLO-31908 re-read the first before the write and left the
    second at its scan-time value. The uncovered interleaving needs no
    concurrent sweep at all, just one run whose scan and write straddle Ally
    answering:

      1. scan reads the surfaces; Ally has not reviewed head -> candidate
      2. Ally posts its consolidated report
      3. the guard re-reads -- the report IS in the list, but only the
         cooldown is re-applied, so nothing sees it
      4. the sweep re-asks for a review that has already landed

    Not reproducible on demand: it needs Ally to answer inside a ~2min window
    against a measured 5m-74m response latency. So these tests ARE the
    acceptance evidence. They simulate the interleaving the same way the
    BLO-31908 class above does -- by serving the scan and the pre-write re-read
    different pages of the SAME surface.
    """

    # _pr(1)'s head, spelled out because these tests turn on head-exactness.
    PR_HEAD = "%040x" % 1

    def setUp(self):
        self._real_request = sweep._request
        self._real_fetch = sweep._fetch_paginated
        self.calls = []
        self.comment_fetches = 0
        self.review_fetches = 0
        self.comment_pages = [[], []]
        self.review_pages = [[], []]

    def tearDown(self):
        sweep._request = self._real_request
        sweep._fetch_paginated = self._real_fetch

    def _install(self, scan_comments=None, reread_comments=None,
                 scan_reviews=None, reread_reviews=None):
        """Serve the scan one view of both surfaces and the pre-write re-read a
        later one. Defaults are empty everywhere, i.e. a genuinely stranded PR.

        Serving the report to the *scan* would prove nothing: _consider_pr
        already skips on ally_has_reviewed_head there, so the write would be
        withheld with or without this guard. Only the re-read page isolates it.
        """
        self.comment_pages = [scan_comments or [], reread_comments or []]
        self.review_pages = [scan_reviews or [], reread_reviews or []]

        def fake_fetch(api_base_url, path, token):
            if "/pulls?state=open" in path:
                return [_pr(1)]
            if "/statuses" in path:
                return [status("pending", PENDING_SINCE)]
            if "/comments" in path:
                index = min(self.comment_fetches, len(self.comment_pages) - 1)
                self.comment_fetches += 1
                return self.comment_pages[index]
            if "/reviews" in path:
                index = min(self.review_fetches, len(self.review_pages) - 1)
                self.review_fetches += 1
                return self.review_pages[index]
            return []

        def fake_request(url, token, method="GET", payload=None):
            self.calls.append((method, url))
            if method == "GET":
                return {"requested_reviewers": [{"login": "allyblockcast"}]}
            return {}

        sweep._fetch_paginated = fake_fetch
        sweep._request = fake_request

    def _now(self):
        # Past STALL_THRESHOLD_SECONDS by a margin whatever it is calibrated to
        # today, so should_refire says yes on the scan and only the guard can
        # stop the write.
        return sweep._parse_iso(PENDING_SINCE) + sweep.STALL_THRESHOLD_SECONDS + HOUR

    def _consider(self, may_refire=True, dry_run=False):
        """Drive the single fixture PR through the real sweep().

        See the identical helper on TestPreWriteRereadGuard for why this can
        no longer call _consider_pr: PEN-3394 moved the write, and therefore
        this guard, into sweep()'s write pass. Calling _consider_pr here would
        make every assertion below pass vacuously.
        """
        real_cap = sweep.MAX_REFIRES_PER_RUN
        if not may_refire:
            sweep.MAX_REFIRES_PER_RUN = 0
        try:
            results = sweep.sweep(
                "o", "r", "tok", "https://api.github.com", now=self._now(), dry_run=dry_run
            )
        finally:
            sweep.MAX_REFIRES_PER_RUN = real_cap
        return results[0]

    def _writes(self):
        return [(method, url) for method, url in self.calls if method != "GET"]

    # -- (a) the comment surface ------------------------------------------

    def test_a_report_landing_on_the_comment_surface_withholds_the_refire(self):
        """Ally answered by comment between the scan and the write."""
        self._install(reread_comments=[issue_comment(body=consolidated_body(self.PR_HEAD))])

        _pr_payload, _head, _pending, refire, reason = self._consider()

        self.assertFalse(refire, "the review we were about to ask for has already landed")
        self.assertTrue(reason.startswith(sweep.REVIEWED_SKIP_REASON_PREFIX), reason)
        self.assertEqual(self._writes(), [], "no DELETE and no POST may be issued")

    # -- (b) the reviews surface ------------------------------------------

    def test_a_report_landing_on_the_reviews_surface_withholds_the_refire(self):
        """Ally answered with a formal review instead.

        Neither surface is sufficient alone -- verified live 2026-08-04, #952
        carried 4 comment-shaped reviews with an EMPTY pulls/952/reviews, while
        #937 carried 4 formal review objects and no comment-shaped one. This
        test and the one above are the two halves of that.
        """
        self._install(reread_reviews=[formal_review(commit_id=self.PR_HEAD)])

        _pr_payload, _head, _pending, refire, reason = self._consider()

        self.assertFalse(refire)
        self.assertTrue(reason.startswith(sweep.REVIEWED_SKIP_REASON_PREFIX), reason)
        self.assertEqual(self._writes(), [])

    # -- (c) the load-bearing negative control -----------------------------

    def test_a_report_against_a_stale_head_does_not_block_the_refire(self):
        """THE control this whole change turns on.

        A naive "any Ally review present -> skip" passes (a) and (b) while
        disabling the reconciler outright: a PR whose head has moved past an
        older review is EXACTLY the state this sweep exists to re-fire, and
        such a PR carries an Ally report on both surfaces permanently. Getting
        this wrong reinstates BLO-22892 silently -- no re-fire, no alarm.

        Serve the stale report to the scan AND the re-read, on BOTH surfaces:
        nothing changed mid-run, and the write must still happen.
        """
        stale_reviews = [formal_review(commit_id=OTHER_SHA)]
        stale_comments = [issue_comment(body=consolidated_body(OTHER_SHA))]
        self._install(
            scan_comments=stale_comments, reread_comments=stale_comments,
            scan_reviews=stale_reviews, reread_reviews=stale_reviews,
        )

        _pr_payload, _head, _pending, refire, _reason = self._consider()

        self.assertTrue(refire, "a review of a superseded head must not suppress reconciliation")
        methods = [method for method, _url in self.calls]
        self.assertIn("DELETE", methods)
        self.assertIn("POST", methods)

    # -- (d) the extra read is only paid for on paths that will write -------

    def test_the_reviews_surface_is_not_refetched_when_the_budget_is_spent(self):
        """may_refire=False is not going to write, so it must not pay."""
        self._install()

        _pr_payload, _head, _pending, refire, reason = self._consider(may_refire=False)

        self.assertFalse(refire)
        self.assertTrue(reason.startswith(sweep.DEFERRED_REASON_PREFIX), reason)
        self.assertEqual(self.review_fetches, 1, "only the scan read, no guard read")

    def test_dry_run_does_not_refetch_the_reviews_surface(self):
        self._install()

        _pr_payload, _head, _pending, refire, reason = self._consider(dry_run=True)

        self.assertTrue(refire, "the plan still reports what a live run would do")
        self.assertIn("DRY-RUN", reason)
        self.assertEqual(self.review_fetches, 1, "only the scan read, no guard read")
        self.assertEqual(self._writes(), [])

    # -- cost, distinguishability, and budget ------------------------------

    def test_the_guard_reads_the_reviews_surface_again_rather_than_trusting_the_scan(self):
        """Pins the extra read itself.

        If a refactor reused the scan's reviews list, (b) would still pass on
        the comment surface alone while the reviews half of the race was fully
        reopened -- the guard would be re-checking the very data whose
        staleness is the defect.
        """
        self._install()

        self._consider()

        self.assertGreaterEqual(
            self.review_fetches, 2,
            "the write path must issue a fresh reviews read, not reuse the scan's",
        )

    def test_the_free_comment_surface_short_circuits_the_paid_reviews_read(self):
        """Cost discipline: the paid read is reached only if the free checks pass.

        The comments are already in hand from the cooldown re-read, so a report
        found there settles it without spending a request.
        """
        self._install(reread_comments=[issue_comment(body=consolidated_body(self.PR_HEAD))])

        self._consider()

        self.assertEqual(self.review_fetches, 1, "the scan's read only")

    def test_a_cooldown_block_pays_for_the_reviews_read_first(self):
        """The deliberate cost inversion: contended no longer skips the paid read.

        This test previously asserted the opposite -- that a cooldown block
        short-circuits the reviews read -- on the premise that the comment
        surface was the one Ally most often answers on. Measured across the 45
        most recent PRs on 2026-09-20, the split was 57 reviews-surface to 0
        comment-surface, so that premise was backwards and the "saving" was
        being taken on the only surface that matters. The read is now issued
        before the cooldown so an answered-AND-contended PR is reported as
        answered on either surface.

        The cost is bounded and small for a reason worth stating: should_refire
        already applied the cooldown at scan time, so for it to block again
        here a marker must have landed in the scan->write gap. That is the rare
        concurrent-write case, not the common path.

        Doubles as the AC3 distinguishability control in the other direction:
        a cooldown skip must keep reporting the cooldown prefix, not be
        relabelled as an already-reviewed skip.
        """
        self._install(reread_comments=[{"body": sweep.MARKER + "\nre-ask", "created_at": _iso(self._now() - 60)}])

        _pr_payload, _head, _pending, refire, reason = self._consider()

        self.assertFalse(refire)
        self.assertTrue(reason.startswith(sweep.REREAD_SKIP_REASON_PREFIX), reason)
        self.assertFalse(reason.startswith(sweep.REVIEWED_SKIP_REASON_PREFIX), reason)
        self.assertEqual(
            self.review_fetches, 2,
            "the guard must read the reviews surface before letting the cooldown decide",
        )

    def test_a_compound_skip_reports_answered_not_contended(self):
        """THE ordering control: when BOTH free checks fire, answered wins.

        Nothing else pins the order the two free checks run in. Both withhold
        the write, so every write-suppression test above passes under either
        order -- which is exactly how this shipped wrong: the cooldown ran
        first, returned REREAD_SKIP_REASON_PREFIX, and _consider_pr took the
        contended branch. That branch deliberately KEEPS pending_since, so a PR
        Ally had answered at this exact head still alarmed and was filed in the
        step summary as concurrency evidence -- pointing an operator at a
        contention problem on a PR that was simply answered.

        The two facts are not equally good. "Someone re-asked 60s ago" is true
        and says nothing about whether the PR is stranded; "Ally reported on
        THIS head" says it is not. Serve the re-read a page carrying both.
        """
        self._install(reread_comments=[
            {"body": sweep.MARKER + "\nre-ask", "created_at": _iso(self._now() - 60)},
            issue_comment(body=consolidated_body(self.PR_HEAD)),
        ])

        _pr_payload, _head, pending_since, refire, reason = self._consider()

        self.assertFalse(refire, "the write is withheld under either order")
        self.assertTrue(
            reason.startswith(sweep.REVIEWED_SKIP_REASON_PREFIX),
            "answered must win over contended, got: %s" % reason,
        )
        self.assertIsNone(
            pending_since,
            "an answered PR is not stranded, so it must not carry pending_since and alarm",
        )
        self.assertEqual(self._writes(), [])
        self.assertEqual(self.review_fetches, 1, "still short-circuits the paid read")

    def test_a_reviews_surface_compound_skip_reports_answered_not_contended(self):
        """The same ordering control on the surface Ally actually uses.

        Identical to the test above except Ally answered with a formal review
        rather than a comment. That distinction is the whole point: across the
        45 most recent PRs in this repo, ZERO Ally consolidated reports landed
        on the comment surface -- every one was on the reviews surface. So the
        test above pins the ordering on the surface responsible for none of
        the observed answers, and this one pins it on the surface responsible
        for all of them. (The matching numerator drifts and is deliberately
        not quoted here; see the ORDERING docstring in refire_still_permitted.)

        This case used to land on the contended branch -- is_alarming=True,
        filed in the step summary as concurrency evidence -- because the
        reviews read was short-circuited once the cooldown had declined.
        """
        self._install(
            reread_comments=[{"body": sweep.MARKER + "\nre-ask", "created_at": _iso(self._now() - 60)}],
            reread_reviews=[formal_review(commit_id=self.PR_HEAD)],
        )

        _pr_payload, _head, pending_since, refire, reason = self._consider()

        self.assertFalse(refire, "the write is withheld under either order")
        self.assertTrue(
            reason.startswith(sweep.REVIEWED_SKIP_REASON_PREFIX),
            "answered must win over contended on the reviews surface too, got: %s" % reason,
        )
        self.assertIsNone(
            pending_since,
            "an answered PR is not stranded, so it must not carry pending_since and alarm",
        )
        self.assertEqual(self._writes(), [])

    def test_the_two_skip_reasons_are_distinguishable(self):
        """AC3: an operator must be able to tell "Ally answered mid-run" from
        "re-asked too recently" off the log line, without reading the diff.

        Neither prefix may be a prefix of the other, or startswith() matching
        -- which is how main() and these tests classify -- would conflate them.
        """
        self.assertNotEqual(sweep.REVIEWED_SKIP_REASON_PREFIX, sweep.REREAD_SKIP_REASON_PREFIX)
        self.assertFalse(sweep.REVIEWED_SKIP_REASON_PREFIX.startswith(sweep.REREAD_SKIP_REASON_PREFIX))
        self.assertFalse(sweep.REREAD_SKIP_REASON_PREFIX.startswith(sweep.REVIEWED_SKIP_REASON_PREFIX))

    def test_an_already_reviewed_skip_does_not_consume_a_refire_budget_slot(self):
        """AC4: MAX_REFIRES_PER_RUN counts writes, not candidates.

        sweep() decrements on the returned re-fire flag, so a PR this guard
        withheld must leave the slot available for the next stranded PR --
        otherwise Ally answering one PR quietly tightens the cap for the rest.
        """
        self._install(reread_reviews=[formal_review(commit_id=self.PR_HEAD)])

        outcome = self._consider()

        self.assertFalse(outcome[3], "a withheld write must not read as a re-fire")

    # -- (e) an answered skip is a healthy PR, not a stranded one ------------

    def test_an_answered_skip_is_not_alarming(self):
        """The guard's success case must not fail the run red.

        The scan normalizes `pending_since = None` when ally_has_reviewed_head
        is true. The guard discovers the SAME fact minutes later, so it must
        do the same -- otherwise main()'s `alarming` list counts a PR the
        guard just proved is not stranded, the step summary reports it twice
        in contradictory terms, and the job exits EXIT_ALARM on the healthiest
        outcome the guard can produce. The fixture is pending 10h against a
        5.5h alarm threshold, so an un-normalized tuple alarms here.
        """
        self._install(reread_reviews=[formal_review(commit_id=self.PR_HEAD)])

        _pr_payload, _head, pending, refire, reason = self._consider()

        self.assertFalse(refire)
        self.assertTrue(reason.startswith(sweep.REVIEWED_SKIP_REASON_PREFIX), reason)
        self.assertIsNone(pending, "an answered head is not pending, exactly as on the scan path")
        self.assertFalse(sweep.is_alarming({"is_draft": False, "pending_since": pending}, self._now()))

    def test_a_contended_skip_still_carries_pending_since_so_it_can_alarm(self):
        """Negative control for the test above: normalize the answered branch
        ONLY. A contended PR is still genuinely waiting on Ally -- a concurrent
        writer re-asked, nobody answered -- so silencing its alarm would hide a
        stranded PR behind the guard.
        """
        self._install(reread_comments=[{"body": sweep.MARKER + "\nre-ask", "created_at": _iso(self._now() - 60)}])

        _pr_payload, _head, pending, refire, reason = self._consider()

        self.assertFalse(refire)
        self.assertTrue(reason.startswith(sweep.REREAD_SKIP_REASON_PREFIX), reason)
        self.assertIsNotNone(pending)
        # The carried pending_since is what lets this PR alarm once the alarm
        # threshold has elapsed; evaluate at that instant, not at the scan's
        # "just past the stall threshold" now, which by construction is
        # earlier than ALARM_THRESHOLD_SECONDS.
        alarm_now = sweep._parse_iso(PENDING_SINCE) + sweep.ALARM_THRESHOLD_SECONDS + HOUR
        self.assertTrue(sweep.is_alarming({"is_draft": False, "pending_since": pending}, alarm_now))

    def test_a_failed_reviews_reread_withholds_the_write_rather_than_writing_blind(self):
        """Fail-closed, matching the cooldown re-read's contract.

        The guard's failures are not swallowed the way request_review's are:
        when it cannot be evaluated the safe direction is to withhold and let
        sweep() isolate and report the PR. Since PEN-3394 that isolation
        happens at the guard's call site in sweep()'s write pass -- see the
        sibling test on TestPreWriteRereadGuard for why it must not propagate.
        """
        self._install()
        real_fetch = sweep._fetch_paginated

        def fetch_then_die(api_base_url, path, token):
            if "/reviews" in path and self.review_fetches >= 1:
                raise urllib.error.URLError("connection reset")
            return real_fetch(api_base_url, path, token)

        sweep._fetch_paginated = fetch_then_die

        _pr_payload, _head, pending_since, refire, reason = self._consider()

        self.assertEqual(self._writes(), [], "a guard that cannot be evaluated must not write")
        self.assertFalse(refire, "a withheld write must not read as a re-fire")
        self.assertTrue(reason.startswith(sweep.SWEEP_ERROR_REASON_PREFIX), reason)
        self.assertIn(sweep.REFIRE_RECHECK_FAILURE_TOKEN, reason)
        self.assertIsNotNone(
            pending_since,
            "the PR is still stranded, so it must keep pending_since and stay able to ALARM",
        )


class TestRereadGuardResidualIsStated(unittest.TestCase):
    """AC2: the residual must be stated, not claimed away.

    The guard narrows the window from the whole scan to the gap between the
    re-read and the POST; it cannot close it, because the GitHub comment API
    offers no compare-and-set. This repo's failure mode of record is asserting
    a guarantee the code does not provide, so the honesty of that docstring is
    itself worth pinning.
    """

    def test_the_docstring_says_the_race_is_narrowed_not_eliminated(self):
        doc = sweep.refire_still_permitted.__doc__ or ""
        self.assertIn("RESIDUAL", doc)
        self.assertIn("does NOT close it", doc)


class TestCooldownReasonWordingUnderClockSkew(unittest.TestCase):
    """The cooldown reason rendered a NEGATIVE age in exactly the headline case.

    `now` is sampled once at the top of the run and shared with should_refire,
    so a marker posted by a concurrent sweep mid-run is genuinely newer than
    this run's clock and `since_last` goes negative -- producing
    "re-asked -3s ago < cooldown 7200s". The decision is correct, but the line
    reads as an arithmetic bug, and that log line is the operator's only
    evidence that sweeps are overlapping.
    """

    NOW = 1_000_000.0

    def test_a_marker_in_the_past_still_reads_as_elapsed_time(self):
        """Negative control: the ordinary case must not be reworded."""
        blocked, reason = sweep.cooldown_blocks_refire([self.NOW - 60], self.NOW)

        self.assertTrue(blocked)
        self.assertIn("re-asked 60s ago", reason)

    def test_a_marker_newer_than_the_scan_clock_renders_no_negative_age(self):
        blocked, reason = sweep.cooldown_blocks_refire([self.NOW + 3], self.NOW)

        self.assertTrue(blocked)
        self.assertNotIn("-3s", reason)
        self.assertIn("3s AFTER", reason)

    def test_the_skew_is_named_rather_than_clamped_away(self):
        """max(0, ...) would render "re-asked 0s ago", which is worse: it hides
        that the marker POSTDATES this run, which is the informative part."""
        _blocked, reason = sweep.cooldown_blocks_refire([self.NOW + 3], self.NOW)

        self.assertIn("concurrent writer", reason)

    def test_the_wording_change_does_not_touch_the_decision(self):
        """The clamp must stay out of the comparison.

        A marker newer than the clock is still inside the cooldown, and one
        older than the cooldown still permits the write.
        """
        self.assertTrue(sweep.cooldown_blocks_refire([self.NOW + 3], self.NOW)[0])
        self.assertTrue(sweep.cooldown_blocks_refire([self.NOW - 1], self.NOW)[0])
        self.assertFalse(
            sweep.cooldown_blocks_refire([self.NOW - sweep.REFIRE_COOLDOWN_SECONDS - 1], self.NOW)[0]
        )


class TestGuardSkipsAreVisibleInTheStepSummary(unittest.TestCase):
    """The guard's outcomes were the least visible of the run's, inverting the
    priority.

    `failed`, `deferred` and `alarming` each get a GITHUB_STEP_SUMMARY section.
    The two guard outcomes did not -- they reached an operator only through the
    per-PR stdout line. The contended count is the ONLY direct evidence that
    dropping the concurrency group (BLO-31818) has a live cost, i.e. that
    sweeps genuinely overlap, so it was the one you had to grep logs to find.
    """

    def setUp(self):
        self._real_sweep = sweep.sweep
        self._env = {
            key: os.environ.get(key)
            for key in ("GITHUB_REPOSITORY", "GITHUB_TOKEN", "GITHUB_STEP_SUMMARY")
        }
        os.environ["GITHUB_REPOSITORY"] = "Blockcast/paperclip"
        os.environ["GITHUB_TOKEN"] = "t"
        handle = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False)
        handle.close()
        self.summary_path = handle.name
        os.environ["GITHUB_STEP_SUMMARY"] = self.summary_path

    def tearDown(self):
        sweep.sweep = self._real_sweep
        os.unlink(self.summary_path)
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _summary_for(self, results):
        sweep.sweep = lambda *a, **k: results
        self.exit_code = 0
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                sweep.main([])
        except SystemExit as exc:
            self.exit_code = exc.code
        with open(self.summary_path, encoding="utf-8") as handle:
            return handle.read()

    def _skip(self, number, prefix, detail, pending_since=None):
        # `pending_since` defaults to None, which is what _consider_pr returns
        # for an ANSWERED skip; pass a real epoch to model a CONTENDED one,
        # which keeps the stale wait so it can still alarm.
        return (_pr(number), "%040x" % number, pending_since, False, "%s -- %s" % (prefix, detail))

    def test_a_contended_skip_past_the_alarm_threshold_still_alarms(self):
        """The two guard outcomes carry different `pending_since`, and the
        alarm follows it. A contended PR (a concurrent writer re-asked, nobody
        answered) is still stranded, so it appears in BOTH the guard section
        and the alarm section -- the same PR, consistently -- and the run exits
        EXIT_ALARM. Contrast the answered case below.
        """
        stale = time.time() - sweep.ALARM_THRESHOLD_SECONDS - HOUR
        summary = self._summary_for([
            self._skip(1, sweep.REREAD_SKIP_REASON_PREFIX, "re-asked 3s ago", pending_since=stale),
        ])

        self.assertIn("1 contended", summary)
        self.assertIn(":rotating_light:", summary)
        self.assertEqual(self.exit_code, sweep.EXIT_ALARM)

    def test_an_answered_skip_never_reaches_the_alarm_section(self):
        """An answered skip arrives with `pending_since=None` (pinned on the
        real tuple in TestPreWriteAllyReviewedGuard), so main() must not
        report the same PR as both healthy and stranded, nor exit red on it.
        """
        summary = self._summary_for([
            self._skip(1, sweep.REVIEWED_SKIP_REASON_PREFIX, "consolidated report on the comment surface"),
        ])

        self.assertIn("1 answered", summary)
        self.assertNotIn(":rotating_light:", summary)
        self.assertEqual(self.exit_code, 0)

    def test_a_contended_skip_is_named_as_concurrency_evidence(self):
        summary = self._summary_for([
            self._skip(1, sweep.REREAD_SKIP_REASON_PREFIX, "re-asked 3s AFTER this run's scan clock"),
        ])

        self.assertIn("withheld by the pre-write guard", summary)
        self.assertIn("1 contended", summary)
        self.assertIn("BLO-31818", summary, "the summary must name the concurrency-group cost")
        self.assertIn("#1", summary)

    def test_an_answered_skip_is_reported_separately_from_a_contended_one(self):
        """AC3 on the summary surface, not only on the per-PR log line.

        Collapsing the two would make a healthy outcome (Ally answered
        mid-run) read as evidence of contention, which is the specific
        misreading the separate counts exist to prevent.
        """
        summary = self._summary_for([
            self._skip(1, sweep.REVIEWED_SKIP_REASON_PREFIX, "consolidated report on the reviews surface"),
        ])

        self.assertIn("1 answered", summary)
        self.assertNotIn("contended", summary)

    def test_both_kinds_are_counted_separately_in_one_run(self):
        summary = self._summary_for([
            self._skip(1, sweep.REREAD_SKIP_REASON_PREFIX, "marker"),
            self._skip(2, sweep.REVIEWED_SKIP_REASON_PREFIX, "comment surface"),
            self._skip(3, sweep.REVIEWED_SKIP_REASON_PREFIX, "reviews surface"),
        ])

        self.assertIn("3 re-fire(s) withheld", summary)
        self.assertIn("1 contended", summary)
        self.assertIn("2 answered", summary)

    def test_a_clean_run_writes_no_guard_section(self):
        """Negative control: the section is conditional, not always-on.

        An unconditional block would put a permanent "0 withheld" line on
        every summary, which is how a signal stops being read.
        """
        summary = self._summary_for([(_pr(1), "%040x" % 1, None, False, "skip: not pending")])

        self.assertNotIn("withheld by the pre-write guard", summary)


class TestRunCliExitCodePolicy(unittest.TestCase):
    """Every abort arm in run_cli() must exit DEGRADED, never ALARM.

    EXIT_ALARM is the "a PR is stranded, go review it" signal. CPython exits
    1 on an uncaught exception and EXIT_ALARM is 1, so ANY exception class
    that escapes run_cli() silently becomes a false alarm -- it sends a human
    to look for review work that does not exist. That is not hypothetical:
    `http.client.IncompleteRead` escaped every arm and did exactly this on
    run 35605218498 (BLO-35151).

    These tests exist because the arms used to live in a bare
    `if __name__ == "__main__"` block, where no test could reach them.
    """

    def _exit_code_for(self, error):
        """Raise `error` out of main() and return run_cli()'s exit code."""
        original_main = sweep.main
        sweep.main = lambda: (_ for _ in ()).throw(error)
        stderr = io.StringIO()
        try:
            with contextlib.redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as caught:
                    sweep.run_cli()
        finally:
            sweep.main = original_main
        return caught.exception.code, stderr.getvalue()

    def test_alarm_and_degraded_are_distinct_nonzero_codes(self):
        """The guard below is meaningless if these two ever collide."""
        self.assertEqual(sweep.EXIT_ALARM, 1)
        self.assertNotEqual(sweep.EXIT_SWEEP_DEGRADED, sweep.EXIT_ALARM)

    def test_incomplete_read_is_degraded_not_alarm(self):
        code, err = self._exit_code_for(http.client.IncompleteRead(b"partial", 68373))
        self.assertEqual(code, sweep.EXIT_SWEEP_DEGRADED)
        self.assertIn("truncated HTTP response", err)

    def test_bad_status_line_is_degraded_not_alarm(self):
        """The arm catches the HTTPException BASE, not just IncompleteRead.

        Naming only the subclass we happened to observe would leave the same
        hole open for its siblings.
        """
        code, err = self._exit_code_for(http.client.BadStatusLine("garbage"))
        self.assertEqual(code, sweep.EXIT_SWEEP_DEGRADED)
        self.assertIn("truncated HTTP response", err)

    def test_incomplete_read_is_not_an_oserror(self):
        """Pins WHY the pre-existing arms could not catch it.

        If a future Python made HTTPException an OSError subclass this test
        fails, flagging that the dedicated arm is now redundant rather than
        letting it rot as unexplained duplication.
        """
        self.assertFalse(issubclass(http.client.HTTPException, OSError))
        self.assertTrue(issubclass(urllib.error.URLError, OSError))

    def test_timeout_error_is_degraded_not_alarm(self):
        code, err = self._exit_code_for(TimeoutError("read timed out"))
        self.assertEqual(code, sweep.EXIT_SWEEP_DEGRADED)
        self.assertIn("socket", err)

    def test_url_error_keeps_its_transport_message(self):
        """Arm precedence is unchanged by the insertion above it."""
        code, err = self._exit_code_for(urllib.error.URLError("dns failure"))
        self.assertEqual(code, sweep.EXIT_SWEEP_DEGRADED)
        self.assertIn("transport", err)

    def test_rate_limit_keeps_its_own_message(self):
        code, err = self._exit_code_for(sweep.RateLimitExhausted("budget spent"))
        self.assertEqual(code, sweep.EXIT_SWEEP_DEGRADED)
        self.assertIn("rate limit exhausted", err)

    def test_unenumerated_exception_classes_are_degraded_not_alarm(self):
        """Pins the class-level invariant the docstring states, not just the
        enumerated arms: ANY escaping exception is degraded, never alarm."""
        import json
        for error in (
            json.JSONDecodeError("Expecting value", "<html>", 0),
            ValueError("unrelated"),
            KeyError("missing"),
            RuntimeError("unrelated"),
        ):
            with self.subTest(error=type(error).__name__):
                code, err = self._exit_code_for(error)
                self.assertEqual(code, sweep.EXIT_SWEEP_DEGRADED)
                self.assertIn("crashed before completing", err)

    def test_deliberate_alarm_exit_passes_through_terminal_arm(self):
        """SystemExit is a BaseException; the terminal `except Exception`
        must not reclassify main()'s own sys.exit(EXIT_ALARM) to degraded."""
        code, _ = self._exit_code_for(SystemExit(sweep.EXIT_ALARM))
        self.assertEqual(code, sweep.EXIT_ALARM)


    def test_exception_raised_while_reporting_a_failure_is_degraded_not_alarm(self):
        """Arm bodies are siblings of the terminal arm, not inside its try.
        Live case: HTTPError.read() re-raising IncompleteRead off the socket
        while the HTTPError arm formats its message (BLO-35151)."""
        class _TruncatedBody:
            def read(self):
                raise http.client.IncompleteRead(b"partial", 100)

            def close(self):
                pass

        error = urllib.error.HTTPError("https://api.github.com/x", 500, "boom", {}, _TruncatedBody())
        code, err = self._exit_code_for(error)
        self.assertEqual(code, sweep.EXIT_SWEEP_DEGRADED)
        self.assertIn("while reporting a failure", err)
class _RendersMainSummary:
    """Harness for asserting on what main() writes to GITHUB_STEP_SUMMARY.

    A plain mixin, not a TestCase, so unittest does not collect it as a
    suite of its own -- the fixtures below are shared by two classes that
    assert on different paragraphs of the same rendered summary.
    """

    def setUp(self):
        self._real_sweep = sweep.sweep
        self._env = {
            k: os.environ.get(k)
            for k in ("GITHUB_REPOSITORY", "GITHUB_TOKEN", "GITHUB_STEP_SUMMARY")
        }
        os.environ["GITHUB_REPOSITORY"] = "Blockcast/paperclip"
        os.environ["GITHUB_TOKEN"] = "t"

    def tearDown(self):
        sweep.sweep = self._real_sweep
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _render_for(self, results):
        """Run main() over `results`; return (step summary, stderr).

        Both surfaces, because they are two renderings of the same run that
        are required to agree. Capturing only the summary is what let the
        console line contradict it for two review cycles (PEN-3394 review):
        a surface with no harness has no test, and `_summary_for` discarded
        stderr entirely.
        """
        handle, path = tempfile.mkstemp()
        os.close(handle)
        os.environ["GITHUB_STEP_SUMMARY"] = path
        sweep.sweep = lambda *a, **k: results
        stderr = io.StringIO()
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
                sweep.main([])
        except SystemExit:
            pass
        try:
            with open(path, encoding="utf-8") as summary:
                return summary.read(), stderr.getvalue()
        finally:
            os.unlink(path)

    def _summary_for(self, results):
        """Run main() over `results` and return what it wrote to the summary."""
        return self._render_for(results)[0]

    def _stderr_for(self, results):
        """Run main() over `results` and return what it wrote to stderr."""
        return self._render_for(results)[1]

    def _write_failure(self, number, exc_name="RateLimitExhausted", pending_since=None):
        # A failed write keeps the pending_since it was read with (the read
        # succeeded; only the write was rejected). Defaulting it to None
        # would encode the alarm-suppressed state -- the BLO-22892 class --
        # as the normal shape. Fresh by default so `alarming` stays 0 in
        # the tests that do not care.
        if pending_since is None:
            pending_since = time.time()
        return (
            _pr(number), "%040x" % number, pending_since, False,
            "%s -- %s (%s)"
            % (sweep.SWEEP_ERROR_REASON_PREFIX, sweep.REFIRE_WRITE_FAILURE_TOKEN, exc_name),
        )

    def _read_failure(self, number):
        return (
            _pr(number), "%040x" % number, None, False,
            "%s -- %s" % (sweep.SWEEP_ERROR_REASON_PREFIX, sweep.RATE_LIMIT_TOKEN),
        )

    def _healthy_skip(self, number):
        """A PR read without incident that simply is not eligible.

        Pads `considered` without joining any failure bucket, which is what
        moves sweep_is_degraded's proportional threshold.
        """
        return (_pr(number), "%040x" % number, None, False, "skip: not stranded")

    def test_a_run_whose_every_write_failed_is_degraded_at_any_repo_size(self):
        """PEN-3394 review: the write bucket needs an ABSOLUTE floor.

        sweep_is_degraded scales its threshold with the open-PR count, but
        write-pass failures are hard-capped at MAX_REFIRE_ATTEMPTS_PER_RUN. Past
        ~100 open PRs the ceiling sits BELOW the threshold, so the write
        population can never trip the alarm on its own and a sweep that
        delivered ZERO re-fires reported itself healthy -- the "broken and
        healthy produce the identical green tick" defect sweep_is_degraded
        exists to remove, reintroduced for the other half of the run.

        111 considered is this repo's own recorded snapshot
        (review-gate-sweep.yml:45); the guard below is what keeps this fixture
        honest if the constants ever move.
        """
        cap = sweep.MAX_REFIRE_ATTEMPTS_PER_RUN
        considered = 111
        self.assertGreater(
            0.1 * considered, cap,
            "fixture must put the proportional threshold ABOVE the write cap, "
            "or it passes for the wrong reason",
        )
        results = [self._write_failure(n) for n in range(1, cap + 1)]
        results += [self._healthy_skip(n) for n in range(cap + 1, considered + 1)]
        self.assertEqual(len(results), considered)

        summary = self._summary_for(results)

        self.assertIn("This run is DEGRADED", summary)

    def test_a_single_write_rejection_on_a_large_repo_does_not_alarm(self):
        """Negative control, and the reason the trigger is a floor of 3 rather
        than `> 0`: one transient rejection must not turn the schedule red for
        everyone. Same argument sweep_is_degraded's own floor encodes.

        Without this, the test above would pass just as happily if the floor
        were removed altogether and any write failure alarmed.
        """
        below = sweep.WRITE_PASS_DEGRADED_FLOOR - 1
        considered = 111
        results = [self._write_failure(n) for n in range(1, below + 1)]
        results += [self._healthy_skip(n) for n in range(below + 1, considered + 1)]

        summary = self._summary_for(results)

        self.assertNotIn("This run is DEGRADED", summary)

    def _recheck_failure(self, number, exc_name="RateLimitExhausted", pending_since=None):
        # A pre-write re-check failure KEEPS pending_since: the PR was read in
        # full in pass 1 and is still stranded, so its alarm verdict is exact.
        # That is the whole reason it must not be bucketed as a read failure.
        if pending_since is None:
            pending_since = time.time()
        return (
            _pr(number), "%040x" % number, pending_since, False,
            "%s -- %s (%s)"
            % (sweep.SWEEP_ERROR_REASON_PREFIX, sweep.REFIRE_RECHECK_FAILURE_TOKEN, exc_name),
        )

    def _deferred(self, number):
        return (
            _pr(number), "%040x" % number, 1.0, False,
            "%s -- over budget" % sweep.DEFERRED_REASON_PREFIX,
        )

    def _refired(self, number):
        return (_pr(number), "%040x" % number, 1.0, True, "re-fired")

    def _guard_withheld(self, number):
        """The CLEAN pre-write guard outcome -- the one the word "withheld"
        is reserved for. It spends NEITHER counter, which is the property
        that makes it the opposite of `_recheck_failure` for budget
        purposes even though both end in "no write happened"."""
        return (
            _pr(number), "%040x" % number, 1.0, False,
            "%s -- marker" % sweep.REREAD_SKIP_REASON_PREFIX,
        )


class TestFailureSummaryAttribution(_RendersMainSummary, unittest.TestCase):
    """A write-pass failure must not be reported as a read-pass abort.

    Both record the exception type in their reason, so a rate-limited WRITE
    reads "re-fire write failed (RateLimitExhausted)" and contains
    RATE_LIMIT_TOKEN as a substring. Bucketing on that alone printed "never
    attempted ... the run aborted" directly above a table row saying the
    write failed -- the summary contradicting itself. The two have different
    remedies (fewer reads vs. a write-side rejection), and an operator reads
    this during exactly the incident the script backstops.
    """

    NEVER_ATTEMPTED = "never attempted"

    def test_a_rate_limited_write_is_not_reported_as_never_attempted(self):
        """The regression. Reverting the REFIRE_WRITE_FAILURE_TOKEN exclusion
        in main()'s `rate_limited` filter makes this fail."""
        summary = self._summary_for([self._write_failure(1), self._write_failure(2)])

        self.assertNotIn(self.NEVER_ATTEMPTED, summary)
        self.assertIn("DID win a slot and were attempted", summary)

    def test_a_read_pass_rate_limit_is_still_reported_as_never_attempted(self):
        """Positive control for the test above.

        Without this, deleting the `rate_limited` bucket outright would pass
        the regression test while destroying the reporting it exists for.
        """
        summary = self._summary_for([self._read_failure(1), self._read_failure(2)])

        self.assertIn(self.NEVER_ATTEMPTED, summary)
        self.assertNotIn("DID win a slot", summary)

    def test_both_kinds_in_one_run_are_counted_separately(self):
        """The buckets partition; neither absorbs the other's members."""
        summary = self._summary_for(
            [self._read_failure(1), self._write_failure(2), self._write_failure(3)]
        )

        self.assertIn("1 of them were never attempted", summary)
        self.assertIn("2 of them DID win a slot", summary)

    def test_write_failures_are_explained_when_nothing_is_deferred(self):
        """The explanation used to be nested under `if deferred:`.

        Write failures and deferrals are independent: a run with rejected
        writes and an empty deferral list printed no account of them at all,
        which is precisely the shape of the reproduction above.
        """
        summary = self._summary_for([self._write_failure(1)])

        self.assertNotIn("deferred past this run's re-fire budget", summary)
        self.assertIn("does NOT consume the MAX_REFIRES_PER_RUN", summary)

    def test_a_non_rate_limit_write_failure_is_still_attributed_to_the_write(self):
        """The bucket keys off the write token, not the exception type."""
        summary = self._summary_for([self._write_failure(1, exc_name="HTTPError")])

        self.assertIn("DID win a slot and were attempted", summary)
        self.assertNotIn(self.NEVER_ATTEMPTED, summary)

    COULD_NOT_BE_READ = "could not be read"

    def test_a_recheck_failure_is_not_reported_as_a_read_failure(self):
        """PEN-3394 review regression.

        `read_failures` was `len(failed) - len(refire_write_failures)`, which
        subtracts the one bucket that was remembered. A pre-write re-check
        failure is in `failed` and in neither exclusion, so it fell through
        into `read_failures` -- and the DEGRADED paragraph then told the
        operator to discount an `alarming` count that was exact, about PRs
        that had been read in full. The same mis-attribution class the
        `rate_limited` filter twelve lines up already excludes it for.

        Reverting the exclusion to a subtraction makes this fail.
        """
        summary = self._summary_for([self._recheck_failure(n) for n in (1, 2, 3)])

        self.assertIn("**This run is DEGRADED** (3 of 3 failed)", summary)
        self.assertNotIn(
            self.COULD_NOT_BE_READ, summary,
            "all three were read in full; only the WRITE was withheld",
        )
        self.assertIn("failed the pre-write re-check", summary)
        self.assertIn("so no write was attempted", summary)

    def test_a_degraded_recheck_only_run_still_explains_what_failed(self):
        """Positive control for the test above.

        Excluding the bucket from `read_failures` without giving it a clause
        of its own would satisfy the regression test while rendering a bare
        "DEGRADED (3 of 3 failed)." with no account of anything -- trading a
        wrong explanation for no explanation. The paragraph partitions
        `failed`, so every member needs a home.
        """
        summary = self._summary_for([self._recheck_failure(n) for n in (1, 2, 3)])

        degraded = summary.split("**This run is DEGRADED**")[1].split("\n\n")[0]
        self.assertGreater(
            len(degraded), 80,
            "the DEGRADED sentence must attribute the failures, not just count them: %r"
            % degraded,
        )
        self.assertIn("3 PR(s)", degraded)
        # The write-pass clause belongs to the OTHER side of the partition and
        # must not render here. The review asked for the positive
        # `alarm verdict is exact` assertion at this line too, but this run has
        # no write failures, so that clause is gated off entirely and the
        # assertion would fail -- verified by rendering. The complement is what
        # this document can actually witness, and it pins the partition.
        self.assertNotIn("alarm verdict is exact", summary)

    def test_read_and_recheck_failures_in_one_run_are_counted_separately(self):
        """The buckets partition; neither absorbs the other's members.

        One genuine read failure must still be reported as one -- the
        exclusion must not swallow the bucket it was narrowing.
        """
        summary = self._summary_for(
            [self._read_failure(1), self._recheck_failure(2), self._recheck_failure(3)]
        )

        self.assertIn("1 %s" % self.COULD_NOT_BE_READ, summary)
        self.assertIn("2 PR(s) were read in full and then failed the pre-write", summary)

    def test_a_write_failure_beside_a_recheck_failure_still_claims_alarming_is_exact(self):
        """Neither bucket makes `alarming` unreliable, so the write clause
        must take its `read_failures == 0` branch rather than the hedged one.

        This is the second-order effect of the same defect: a re-check
        failure leaking into `read_failures` also flipped this sentence into
        "they are not what makes `alarming=N` unreliable" on a run where
        nothing made it unreliable.

        Four failures, because sweep_is_degraded has a floor of 3 and the
        DEGRADED paragraph does not render below it.
        """
        summary = self._summary_for(
            [self._write_failure(1), self._write_failure(2)]
            + [self._recheck_failure(3), self._recheck_failure(4)]
        )

        self.assertIn("is trustworthy", summary)
        self.assertNotIn(
            "they are not what makes", summary,
            "the hedged branch is for genuine READ failures, of which this run has none",
        )


class TestTotalFailureSurfacesAgreeWithTheParagraph(_RendersMainSummary, unittest.TestCase):
    """PEN-3394 review: the two surfaces that report `len(failed)` as a total.

    The DEGRADED paragraph partitions `failed` into three buckets and
    describes each correctly. The section heading above it and the console
    line at the end of main() interpolated the raw total under the wording
    "%d PR(s) could not be evaluated" -- a read-failure statement -- so on a
    write-pass-only run one document said both things about the same PRs, and
    the console additionally asserted a cause ("the sweep itself did not run")
    and a verdict ("`alarming` is not a clean bill of health") that the
    paragraph directly contradicted.

    Neither surface had a test. These pin one assertion per surface, and the
    read-failure cases below are the negative controls: the fix must not buy
    agreement by making every run read as reassuring.
    """

    def test_the_heading_does_not_call_a_fully_evaluated_pr_unevaluated(self):
        summary = self._summary_for([self._recheck_failure(n) for n in (1, 2, 3)])
        heading = [l for l in summary.split("\n") if l.startswith("### :warning:")][0]

        self.assertNotIn("could not be evaluated", heading)
        self.assertNotIn("could not be read", heading)
        self.assertIn("3 PR(s) failed this run", heading)
        self.assertIn("3 failed the pre-write re-check", heading)

    def test_the_console_line_does_not_claim_the_sweep_did_not_run(self):
        stderr = self._stderr_for([self._recheck_failure(n) for n in (1, 2, 3)])

        self.assertIn("SWEEP DEGRADED", stderr)
        self.assertNotIn("the sweep itself did not run", stderr)
        self.assertNotIn("could not be evaluated", stderr)
        self.assertNotIn(
            "is not a clean bill of health", stderr,
            "all three were read in full, so `alarming` is exact -- the summary "
            "says so in the same run",
        )
        self.assertIn("was read in full", stderr)
        self.assertIn("`alarming=0` IS exact", stderr)

    def test_a_read_failure_still_reports_alarming_as_untrustworthy(self):
        """Negative control for the console test above.

        Reporting every degraded run as "the re-fire did not land, alarming is
        exact" would agree with the paragraph and be wrong in the direction
        that costs a stranded PR. A genuine read failure must keep the
        untrustworthy verdict.
        """
        summary, stderr = self._render_for([self._read_failure(n) for n in (1, 2, 3)])

        self.assertIn("3 could not be read", stderr)
        self.assertIn("is not a clean bill of health", stderr)
        self.assertNotIn("IS exact", stderr)
        self.assertIn("could not be read", summary)

    def test_one_read_failure_among_write_pass_failures_takes_the_cautious_branch(self):
        """The branch keys off ANY read failure, not off the majority.

        One unread PR is enough to make `alarming` an undercount, so a run
        that is mostly write-pass failures must still report it as such.
        """
        stderr = self._stderr_for(
            [self._read_failure(1), self._write_failure(2)]
            + [self._recheck_failure(3), self._recheck_failure(4)]
        )

        self.assertIn("1 of them could not be read", stderr)
        self.assertIn("is not a clean bill of health", stderr)

    def test_both_surfaces_break_the_total_into_buckets_that_sum_to_it(self):
        """The heading and the console line name the same partition.

        They are rendered from one shared `failure_breakdown` call, so this
        pins that they cannot drift apart -- the failure mode that produced
        this finding in the first place was one surface being updated and the
        other not.
        """
        results = (
            [self._read_failure(1)]
            + [self._write_failure(2), self._write_failure(3)]
            + [self._recheck_failure(4)]
        )
        summary, stderr = self._render_for(results)
        heading = [l for l in summary.split("\n") if l.startswith("### :warning:")][0]

        breakdown = "1 could not be read, 2 failed the re-fire write, 1 failed the pre-write re-check"
        self.assertIn(breakdown, heading)
        self.assertIn(breakdown, stderr)
        self.assertIn("4 PR(s) failed", heading)
        self.assertIn("4 of 4 PR(s) failed", stderr)


class TestFailureBreakdown(unittest.TestCase):
    """`failure_breakdown` names only the non-empty buckets."""

    def test_it_omits_empty_buckets(self):
        self.assertEqual(
            sweep.failure_breakdown(0, 0, 3), "3 failed the pre-write re-check"
        )
        self.assertEqual(sweep.failure_breakdown(2, 0, 0), "2 could not be read")

    def test_it_names_every_non_empty_bucket(self):
        self.assertEqual(
            sweep.failure_breakdown(1, 2, 3),
            "1 could not be read, 2 failed the re-fire write, "
            "3 failed the pre-write re-check",
        )


class TestWritePassFailureTokens(unittest.TestCase):
    """The token set every derived bucket excludes.

    `read_failures` and `rate_limited` are both its complement, so a token
    added here must leave both at once. That single source is the point: this
    same correction was made at three separate call sites, each time by
    editing one and missing the others.
    """

    def test_every_write_pass_token_is_recognised(self):
        for token in sweep.WRITE_PASS_FAILURE_TOKENS:
            self.assertTrue(
                sweep.is_write_pass_failure("skip: error -- %s (HTTPError)" % token),
                "%r must be classified as a write-pass failure" % token,
            )

    def test_a_read_pass_failure_is_not_one(self):
        self.assertFalse(
            sweep.is_write_pass_failure(
                "skip: error -- %s" % sweep.RATE_LIMIT_TOKEN
            )
        )

    def test_the_tokens_do_not_overlap(self):
        """Substring matching means an overlapping pair would double-count.

        REFIRE_RECHECK_FAILURE_TOKEN documents this requirement; nothing
        enforced it.
        """
        for outer in sweep.WRITE_PASS_FAILURE_TOKENS:
            for inner in sweep.WRITE_PASS_FAILURE_TOKENS:
                if outer is inner:
                    continue
                self.assertNotIn(
                    inner, outer,
                    "%r contains %r, so a %r failure would also match %r"
                    % (outer, inner, outer, inner),
                )


class TestDeferralHeaderReportsMeasuredDelivery(_RendersMainSummary, unittest.TestCase):
    """Write-failures WITH deferrals -- the combination that renders the
    deferral header and the DEGRADED paragraph at the same time.

    Neither was covered: the write-failure cases all had an empty deferral
    list and the deferral cases had no failures, so the two paragraphs that
    interpolate `failed` were only ever exercised in the states where the
    conflation is invisible. In this state the header interpolated the
    CONSTANT MAX_REFIRES_PER_RUN as the count delivered -- reporting a
    fully-spent budget two lines under "re-fired 0" -- and promised a
    rotation that cannot happen, because a failed write posts no marker, so
    starts no cooldown, so those PRs keep their longer waits and rank ahead
    again. The population is stationary, not rotating.
    """

    def _spent_budget_claim(self):
        """What the header must NOT say: the cap, reported as delivered."""
        return "%d of MAX_REFIRES_PER_RUN=%d delivered" % (
            sweep.MAX_REFIRES_PER_RUN,
            sweep.MAX_REFIRES_PER_RUN,
        )

    def test_a_run_that_delivered_nothing_does_not_report_a_spent_budget(self):
        """The regression. Reverting to the constant makes this fail."""
        summary = self._summary_for(
            [self._write_failure(n) for n in (1, 2)] + [self._deferred(3)]
        )

        self.assertIn(
            "0 of MAX_REFIRES_PER_RUN=%d delivered" % sweep.MAX_REFIRES_PER_RUN, summary
        )
        self.assertNotIn(self._spent_budget_claim(), summary)
        # Attempts = delivered + rejected writes, so both failures count.
        self.assertIn(
            "2 of MAX_REFIRE_ATTEMPTS_PER_RUN=%d attempted"
            % sweep.MAX_REFIRE_ATTEMPTS_PER_RUN,
            summary,
        )

    def test_the_delivered_figure_is_the_measured_count_not_the_cap(self):
        """Two delivered under a cap of five must read as two, so the header
        cannot pass by coincidence on a run that happens to spend it all."""
        summary = self._summary_for(
            [self._refired(1), self._refired(2), self._deferred(3)]
        )

        self.assertIn(
            "2 of MAX_REFIRES_PER_RUN=%d delivered" % sweep.MAX_REFIRES_PER_RUN, summary
        )
        self.assertNotIn(self._spent_budget_claim(), summary)
        # No write failed, so attempted must equal delivered: the cap here
        # would read as write failures that never happened.
        self.assertIn(
            "2 of MAX_REFIRE_ATTEMPTS_PER_RUN=%d attempted"
            % sweep.MAX_REFIRE_ATTEMPTS_PER_RUN,
            summary,
        )

    def test_the_rotation_guarantee_is_withdrawn_when_a_write_failed(self):
        """A failed write starts no cooldown, so the deferred set does not
        advance. Claiming it does reads a starvation as fairness working."""
        summary = self._summary_for([self._write_failure(1), self._deferred(2)])

        self.assertIn("do **not** rank first next run", summary)
        self.assertNotIn("so these rank first next run", summary)

    def test_the_rotation_guarantee_is_withdrawn_when_a_recheck_failed(self):
        """The gap. A withheld re-fire enters `_refire_pr` no more than a
        failed write does, so it posts no marker and starts no cooldown
        either -- those PRs keep the longer waits that won them a slot.

        Gating the withdrawal on write failures alone let this run claim the
        deferred set advances while the failed-run paragraph above said those
        same PRs "sort back to the front of the next run": two clauses of one
        summary, 60 lines apart, contradicting each other.
        """
        summary = self._summary_for([self._recheck_failure(1), self._deferred(2)])

        self.assertIn("do **not** rank first next run", summary)
        self.assertNotIn("so these rank first next run", summary)
        # And it must NAME the bucket: "1 re-fire write(s) failed" on a run
        # with no failed write would trade one false statement for another.
        self.assertIn("1 pre-write re-check(s) failed", summary)
        self.assertNotIn("re-fire write(s) failed", summary)

    def test_the_withdrawal_names_both_buckets_when_both_are_present(self):
        """One run can carry both, and the operator has to know which to fix.
        Collapsing them under either verb sends them to the wrong surface."""
        summary = self._summary_for(
            [self._write_failure(1), self._recheck_failure(2), self._deferred(3)]
        )

        self.assertIn("do **not** rank first next run", summary)
        self.assertIn("1 re-fire write(s) failed", summary)
        self.assertIn("1 pre-write re-check(s) failed", summary)

    def test_a_deferral_caused_by_recheck_failures_reports_them_as_attempted(self):
        """The header's `attempted` figure is measured against a ceiling of
        `attempted + recheck_failures`, so a bucket the ceiling counts must
        appear in the figure. Omitting it rendered "0 of
        MAX_REFIRE_ATTEMPTS_PER_RUN=N attempted" beside PRs deferred for
        hitting exactly N -- unspent budget over a genuine exhaustion."""
        summary = self._summary_for(
            [self._recheck_failure(n) for n in (1, 2)] + [self._deferred(3)]
        )

        self.assertIn(
            "2 of MAX_REFIRE_ATTEMPTS_PER_RUN=%d attempted"
            % sweep.MAX_REFIRE_ATTEMPTS_PER_RUN,
            summary,
        )
        # Nothing was delivered, so the delivery cap stays untouched: the two
        # counters move independently and this is the run that proves it.
        self.assertIn(
            "0 of MAX_REFIRES_PER_RUN=%d delivered" % sweep.MAX_REFIRES_PER_RUN, summary
        )
        self.assertNotIn(self._spent_budget_claim(), summary)

    def test_every_attempt_bucket_counts_toward_the_attempted_figure(self):
        """All three at once, so the figure cannot pass by coincidence on a
        run where two buckets happen to be empty."""
        summary = self._summary_for(
            [
                self._refired(1),
                self._write_failure(2),
                self._recheck_failure(3),
                self._deferred(4),
            ]
        )

        self.assertIn(
            "3 of MAX_REFIRE_ATTEMPTS_PER_RUN=%d attempted"
            % sweep.MAX_REFIRE_ATTEMPTS_PER_RUN,
            summary,
        )
        self.assertIn(
            "1 of MAX_REFIRES_PER_RUN=%d delivered" % sweep.MAX_REFIRES_PER_RUN, summary
        )

    def test_the_rotation_guarantee_still_holds_when_every_write_landed(self):
        """Positive control. Without it, deleting the rotation clause
        outright would pass the test above while destroying the claim this
        PR exists to make true.

        Also pins the `else` clause's MEASURED figure (PEN-3394 review). The
        sibling above pins the deferral header's figures but stops two lines
        short of this one, so mutating `% len(refired)` to
        `% MAX_REFIRES_PER_RUN` used to leave the suite green -- the exact
        cap-vs-measured regression this class exists to prevent, surviving
        inside the same section. One delivered re-fire makes the two
        distinguishable (1 vs 5).
        """
        summary = self._summary_for([self._refired(1), self._deferred(2)])

        self.assertIn("less than the 1 re-fired", summary)
        self.assertIn("rank ahead of THOSE next run", summary)
        self.assertNotIn("do **not** rank first next run", summary)
        # The claim is bounded on purpose: it ranks these against the PRs
        # re-fired THIS run, and must not promise coverage the static
        # `pending_since` sort key cannot deliver. Asserting the caveat by its
        # property, not its phrasing, plus the row that carries the real fix.
        self.assertIn("not a coverage guarantee", summary)
        self.assertIn("PEN-3589", summary)
        self.assertNotIn("so these rank first next run", summary)

    def test_a_run_interval_longer_than_the_cooldown_still_bounds_at_one_run(self):
        """Pins the `max(1, ...)` INSIDE the coverage-bound expression, which
        is a different guard from the clamp on the constant and is reachable
        with entirely legal settings (PEN-3394 review).

        The constant's clamp stops a zero DIVISOR. This stops a zero
        QUOTIENT: once the run interval exceeds the cooldown, floor division
        gives 0, and `MAX_REFIRES_PER_RUN * 0` renders "reaches roughly 0
        distinct PRs" -- telling an operator the sweep covers nothing, on a
        run that just delivered. The floor is 1 because a single run always
        reaches MAX_REFIRES_PER_RUN of them, cooldown or no cooldown.

        6h is not hypothetical: it is the value the sibling clamp test
        `test_a_positive_run_interval_is_left_alone` already calls a
        deliberately long interval. Asserting on the RENDERED figure rather
        than on a rebuilt expression is the point -- deleting the
        `max(1, ...)` at the use site leaves the whole suite green.
        """
        interval = 6 * 60 * 60
        self.assertGreater(
            interval, sweep.REFIRE_COOLDOWN_SECONDS,
            "fixture must put the interval ABOVE the cooldown, or the quotient "
            "is not 0 and the test passes for the wrong reason",
        )
        real_interval = sweep.SWEEP_RUN_INTERVAL_SECONDS
        sweep.SWEEP_RUN_INTERVAL_SECONDS = interval
        self.addCleanup(setattr, sweep, "SWEEP_RUN_INTERVAL_SECONDS", real_interval)

        summary = self._summary_for([self._refired(1), self._deferred(2)])

        self.assertIn("= %d distinct PRs" % sweep.MAX_REFIRES_PER_RUN, summary)
        self.assertNotIn("= 0 distinct PRs", summary)

    def test_a_write_only_failure_does_not_discredit_the_alarm_count(self):
        """Every PR was READ; only the write was rejected. `alarming` is
        therefore exact, and telling the operator to discount it removes the
        one trustworthy number on the run where it is the only signal.

        Three failures, because sweep_is_degraded has a floor of 3 -- below
        it nothing renders and the assertion would pass vacuously.
        """
        summary = self._summary_for([self._write_failure(n) for n in (1, 2, 3)])

        self.assertIn("This run is DEGRADED", summary)
        self.assertIn("read in full and failed on the re-fire WRITE", summary)
        # The verdict word itself, which this test is named for but never
        # asserted on (PEN-3394 review): mutating it to "UNKNOWN" left the
        # suite green while rendering the self-contradicting "...so their
        # alarm verdict is UNKNOWN and `alarming=N` is trustworthy...".
        self.assertIn("alarm verdict is exact", summary)
        self.assertNotIn("could not be read", summary)

    def test_a_read_failure_still_discredits_the_alarm_count(self):
        """Positive control for the test above: gating the sentence must not
        delete it. A PR that could not be read cannot be shown un-stranded."""
        summary = self._summary_for([self._read_failure(n) for n in (1, 2, 3)])

        self.assertIn("This run is DEGRADED", summary)
        self.assertIn("could not be read", summary)
        self.assertNotIn("read in full and failed on the re-fire WRITE", summary)

    def test_a_mixed_run_attributes_each_failure_kind_to_its_own_side(self):
        """Neither clause absorbs the other's members."""
        summary = self._summary_for(
            [self._read_failure(n) for n in (1, 2, 3)] + [self._write_failure(4)]
        )

        self.assertIn("3 could not be read", summary)
        self.assertIn("1 PR(s) were read in full and failed on the re-fire WRITE", summary)
        self.assertNotIn("is trustworthy", summary)
        self.assertIn("they are not what makes `alarming=", summary)

    def test_the_write_clause_states_the_verdict_is_exact_not_that_they_are_counted(self):
        """Re-fire eligibility (STALL_THRESHOLD) is below the alarm threshold,
        so a write-failed PR is normally NOT alarming. Claiming they "are
        counted in `alarming=N`" pointed the operator at an alarm table that
        does not list them. The true property is that their verdict is
        exact; rendered against a non-zero count so the sentence cannot pass
        by reading `alarming=0` as vacuously true."""
        summary = self._summary_for([
            self._write_failure(
                1, pending_since=time.time() - sweep.ALARM_THRESHOLD_SECONDS - 60
            ),
            self._write_failure(2),
            self._write_failure(3),
        ])

        self.assertIn("This run is DEGRADED", summary)
        self.assertIn("`alarming=1` is trustworthy", summary)
        self.assertNotIn("counted in `alarming=", summary)


class TestSectionsOfOneSummaryAgree(_RendersMainSummary, unittest.TestCase):
    """Cross-section invariants over a SINGLE rendered summary.

    Every class above asserts on one paragraph. That is why a contradiction
    between two of them survived two review cycles: correcting the deferral
    header's `attempted` figure (PEN-3394) left the DEGRADED paragraph 60
    lines above it calling the very same PRs "WITHHELD rather than
    attempted", and no test rendered both at once to notice. These assert
    on the whole document, so the class closes rather than the instance.
    """

    def test_the_degraded_paragraph_and_the_deferral_header_agree(self):
        """The one run that renders both: re-check failures spend the attempt
        ceiling, and deferrals are what make the header render at all. The
        paragraph must not deny what the header counts."""
        summary = self._summary_for(
            [self._recheck_failure(n) for n in (1, 2, 3, 4)] + [self._deferred(5)]
        )

        # The header counts them ...
        self.assertIn(
            "4 of MAX_REFIRE_ATTEMPTS_PER_RUN=%d attempted"
            % sweep.MAX_REFIRE_ATTEMPTS_PER_RUN,
            summary,
        )
        # ... so the paragraph may not say the opposite about the same PRs.
        degraded = summary.split("**This run is DEGRADED**")[1].split("\n\n")[0]
        self.assertNotIn("rather than attempted", degraded)
        self.assertIn("no write was attempted", degraded)

    def test_withheld_names_only_the_bucket_that_spends_no_budget(self):
        """"withheld" is a reserved term: it is the CLEAN guard outcome, which
        spends neither counter and has its own section. A re-check failure
        spends the attempt ceiling, so borrowing the word puts two opposite
        budget semantics on one word in a document that renders both.

        Asserting on the partition rather than on either wording means any
        future re-use in the DEGRADED paragraph fails here, whatever phrasing
        it arrives in.
        """
        summary = self._summary_for(
            [self._recheck_failure(n) for n in (1, 2, 3)]
            + [self._guard_withheld(4), self._deferred(5)]
        )

        # Both sections are actually present, or the partition is vacuous.
        self.assertIn("re-fire(s) withheld by the pre-write guard", summary)
        degraded = summary.split("**This run is DEGRADED**")[1].split("\n\n")[0]
        self.assertIn("failed the pre-write re-check", degraded)

        self.assertNotIn("withheld", degraded.lower())

    def test_the_degraded_paragraph_cites_no_figure_when_nothing_was_deferred(self):
        """The paragraph renders on `refire_recheck_failures`; the deferral
        header that carries the budget figures renders on `deferred`. Two
        independent gates, so anything the paragraph borrows from the header
        dangles whenever the first is true and the second is false -- and
        that is the COMMON degraded run, not the corner: a deferral needs a
        ceiling to be exceeded, while DEGRADED needs only 3 failures at >=10%.

        The sibling cases above both pass `self._deferred(5)`, so they render
        the rarer document and could not see this. Asserted as "the paragraph
        names no figure", which is a property of the partition -- a figure is
        by definition rendered by another section -- rather than a pin on the
        one phrasing that dangled.
        """
        summary = self._summary_for([self._recheck_failure(n) for n in (1, 2, 3)])
        degraded = summary.split("**This run is DEGRADED**")[1].split("\n\n")[0]

        # Non-vacuous in both directions: the paragraph really rendered, and
        # the section whose figures it used to cite really did not.
        self.assertIn("failed the pre-write re-check", degraded)
        self.assertNotIn("MAX_REFIRE_ATTEMPTS_PER_RUN=", summary)

        self.assertNotIn("figure", degraded)
        # ... and the budget fact survives on its own authority, so the
        # citation cannot be dropped by dropping the claim with it.
        self.assertIn("MAX_REFIRE_ATTEMPTS_PER_RUN", degraded)


class TestAttemptCeilingIsClamped(unittest.TestCase):
    """MAX_REFIRE_ATTEMPTS_PER_RUN below MAX_REFIRES_PER_RUN makes the
    delivery cap unreachable, and the deferral message would then name the
    attempt ceiling while implying the budget had been spent. Operator-set,
    so the clamp is about making the state unrepresentable, not likely."""

    def _reload_with(self, **env):
        previous = {k: os.environ.get(k) for k in env}
        os.environ.update({k: str(v) for k, v in env.items()})
        try:
            module = importlib.util.module_from_spec(_SPEC)
            _SPEC.loader.exec_module(module)
            return module
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_an_attempt_ceiling_below_the_delivery_cap_is_raised_to_it(self):
        module = self._reload_with(MAX_REFIRES_PER_RUN=5, MAX_REFIRE_ATTEMPTS_PER_RUN=2)

        self.assertEqual(module.MAX_REFIRE_ATTEMPTS_PER_RUN, 5)

    def test_an_attempt_ceiling_above_the_delivery_cap_is_left_alone(self):
        """The clamp must not flatten a deliberately generous ceiling."""
        module = self._reload_with(MAX_REFIRES_PER_RUN=5, MAX_REFIRE_ATTEMPTS_PER_RUN=40)

        self.assertEqual(module.MAX_REFIRE_ATTEMPTS_PER_RUN, 40)

    def test_a_zero_run_interval_cannot_divide_by_zero_after_the_writes_land(self):
        """SWEEP_RUN_INTERVAL_SECONDS is operator-set and is a DIVISOR in the
        coverage-bound sentence, which is printed AFTER pass 2's writes have
        landed. An unclamped 0 raises ZeroDivisionError there, and main()'s
        handler catches only RateLimitExhausted/HTTPError/URLError -- so a
        stray env value turns a fully-successful sweep into a bare traceback
        with its work already done. Same class as the ceiling clamp above:
        make it unrepresentable rather than merely unlikely (PEN-3394 review).
        """
        module = self._reload_with(SWEEP_RUN_INTERVAL_SECONDS=0)

        self.assertEqual(module.SWEEP_RUN_INTERVAL_SECONDS, 1)
        # Deliberately the ONLY assertion here. A second one rebuilding the
        # production expression was dropped: `MAX_REFIRES_PER_RUN * max(1, N)
        # >= MAX_REFIRES_PER_RUN` holds for every N, so it could not fail
        # whatever the clamp did -- it carried its own `max(1, ...)` and so
        # exercised a copy, not the print at the use site. Same mistake the
        # finding one commit earlier was raised about. The use-site guard is
        # a DIFFERENT guard and is pinned against the rendered figure, in
        # TestDeferralHeaderReportsMeasuredDelivery (PEN-3394 review).

    def test_a_positive_run_interval_is_left_alone(self):
        """The clamp must not flatten a deliberately long interval."""
        module = self._reload_with(SWEEP_RUN_INTERVAL_SECONDS=6 * 60 * 60)

        self.assertEqual(module.SWEEP_RUN_INTERVAL_SECONDS, 6 * 60 * 60)

    def test_the_default_is_still_twice_the_delivery_cap(self):
        module = self._reload_with(MAX_REFIRES_PER_RUN=7, MAX_REFIRE_ATTEMPTS_PER_RUN="")

        self.assertEqual(module.MAX_REFIRE_ATTEMPTS_PER_RUN, 14)


class TestRefireWriteOrdering(unittest.TestCase):
    """The marker comment must be the FIRST write `_refire_pr` issues.

    PEN-3394 review. The marker is the cooldown's ONLY token, and the two
    writes have asymmetric failure contracts: `request_review` swallows its own
    failures and returns a bool, while the comment POST raises. So under the
    old order -- wake first, token second -- a comment that raised left the
    reviewer already woken and nothing to throttle the next run: `succeeded`
    is not incremented, no marker exists, `cooldown_blocks_refire` stays False,
    `pending_since` has not moved, and under longest-wait ranking the PR is
    still rank 0. The next hourly run serves it first and wakes Ally again,
    forever -- while `unserved_breakdown` reports it to the operator as NOT
    served. GitHub's secondary content-creation limit is the realistic trigger,
    and the loop invites it by POSTing up to MAX_REFIRES_PER_RUN back-to-back.

    These drive the real `_refire_pr`. Every sweep-level call site stubs it
    wholesale, which is why the ordering had no coverage at all.
    """

    def setUp(self):
        self._real_request = sweep._request
        self.calls = []

    def tearDown(self):
        sweep._request = self._real_request

    def _install(self, comment_raises=False):
        def fake_request(url, token, method="GET", payload=None):
            tail = url.rsplit("/repos/", 1)[-1]
            is_comment = method == "POST" and "/issues/" in tail and tail.endswith("comments")
            if is_comment and comment_raises:
                raise urllib.error.HTTPError(url, 403, "secondary rate limit", None, None)
            self.calls.append((method, tail, payload))
            if method == "GET":
                return {"requested_reviewers": [{"login": "allyblockcast"}]}
            return {}

        sweep._request = fake_request

    def _refire(self):
        now = time.time()
        sweep._refire_pr(
            "o", "r", _pr(1383), "%040x" % 1383, now - 30 * HOUR,
            "tok", "https://api.github.com", now,
        )

    def _writes(self):
        return [(m, url, payload) for m, url, payload in self.calls if m in ("POST", "DELETE")]

    def _posted_comment_body(self):
        """The body the comment POST actually carried.

        The payload is captured rather than reconstructed on purpose
        (PEN-3394 review). Calling build_comment_body() here and asserting on
        the result tests build_comment_body, not _refire_pr's use of it -- and
        that gap was real: deleting `request_pending=True` from the live call
        site left the whole suite green while every re-fire began posting
        "that call failed" about a request that had not been attempted yet.
        """
        bodies = [
            (payload or {}).get("body")
            for m, url, payload in self.calls
            if m == "POST" and "/issues/" in url and url.endswith("comments")
        ]
        self.assertEqual(len(bodies), 1, "expected exactly one marker comment POST")
        return bodies[0]

    def test_the_marker_comment_is_written_before_the_reviewer_wake(self):
        self._install()

        self._refire()

        writes = self._writes()
        self.assertTrue(writes, "the re-fire must issue writes")
        first_method, first_url, _first_payload = writes[0]
        self.assertEqual(first_method, "POST")
        self.assertTrue(
            "/issues/" in first_url and first_url.endswith("comments"),
            "the cooldown token must be the first write, got %r" % (first_url,),
        )
        self.assertTrue(
            any("requested_reviewers" in url for _m, url, _p in writes),
            "the reviewer wake must still be delivered on the happy path",
        )

    def test_a_failed_marker_comment_delivers_no_reviewer_wake(self):
        """The property, not the ordering expression.

        This is what makes a failed re-fire cost a SKIPPED wake instead of an
        unthrottled one. Mutating `_refire_pr` back to wake-then-token leaves
        the test above green on the happy path but fails here, because the
        wake is delivered before the write that raises.
        """
        self._install(comment_raises=True)

        with self.assertRaises(urllib.error.HTTPError):
            self._refire()

        self.assertEqual(
            [url for _m, url, _p in self.calls if "requested_reviewers" in url],
            [],
            "no review request may be issued once the cooldown token has failed",
        )

    def test_the_marker_does_not_assert_a_request_outcome_it_cannot_know(self):
        """The body is built before `request_review` runs, so it must not claim
        the request succeeded or failed -- either would be an audit trail
        asserting an outcome that had not happened when it was written.

        Asserted against the body the POST actually carried, not against a
        freshly-built one (PEN-3394 review). `_refire_pr` chooses the variant
        by passing `request_pending=True`, and that keyword is the whole of the
        choice: dropping it falls through to the `else` branch, whose sentence
        -- "that call failed" -- is not merely stale but false, since at that
        point the request has not been attempted. Rebuilding the body here
        exercised build_comment_body and left that mutation invisible.
        """
        self._install()

        self._refire()

        body = self._posted_comment_body()
        self.assertIn(sweep.MARKER, body)
        self.assertIn("Requesting a review", body)
        self.assertNotIn("that call failed", body)
        self.assertNotIn("Requested a review", body)


if __name__ == "__main__":
    unittest.main()

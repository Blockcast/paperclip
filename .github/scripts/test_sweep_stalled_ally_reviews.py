#!/usr/bin/env python3
"""Pins the branches of sweep-stalled-ally-reviews.py's pure decision logic.

Stdlib only, no network -- first_pending_since(), should_refire(),
is_alarming(), and ally_has_reviewed_head() are pure functions.
Run: python3 -m unittest discover -s .github/scripts -p 'test_*.py'
"""

import contextlib
import importlib.util
import io
import os
import tempfile
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
        self._real_max = sweep.MAX_REFIRES_PER_RUN
        self._real_max_attempts = sweep.MAX_REFIRE_ATTEMPTS_PER_RUN
        self.refired = []
        sweep._refire_pr = lambda o, r, pr, h, p, t, u, n: self.refired.append(pr["number"])

    def tearDown(self):
        sweep._fetch_paginated = self._real_fetch
        sweep._consider_pr = self._real_consider
        sweep._refire_pr = self._real_refire
        sweep.MAX_REFIRES_PER_RUN = self._real_max
        sweep.MAX_REFIRE_ATTEMPTS_PER_RUN = self._real_max_attempts

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
        now = sweep._parse_iso("2026-08-01T00:00:00Z") + 10 * HOUR

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

    def _summary_for(self, results):
        """Run main() over `results` and return what it wrote to the summary."""
        handle, path = tempfile.mkstemp()
        os.close(handle)
        os.environ["GITHUB_STEP_SUMMARY"] = path
        sweep.sweep = lambda *a, **k: results
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                sweep.main([])
        except SystemExit:
            pass
        try:
            with open(path, encoding="utf-8") as summary:
                return summary.read()
        finally:
            os.unlink(path)

    def _write_failure(self, number, exc_name="RateLimitExhausted"):
        return (
            _pr(number), "%040x" % number, None, False,
            "%s -- %s (%s)"
            % (sweep.SWEEP_ERROR_REASON_PREFIX, sweep.REFIRE_WRITE_FAILURE_TOKEN, exc_name),
        )

    def _read_failure(self, number):
        return (
            _pr(number), "%040x" % number, None, False,
            "%s -- %s" % (sweep.SWEEP_ERROR_REASON_PREFIX, sweep.RATE_LIMIT_TOKEN),
        )

    def _deferred(self, number):
        return (
            _pr(number), "%040x" % number, 1.0, False,
            "%s -- over budget" % sweep.DEFERRED_REASON_PREFIX,
        )

    def _refired(self, number):
        return (_pr(number), "%040x" % number, 1.0, True, "re-fired")


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

    def test_the_rotation_guarantee_is_withdrawn_when_a_write_failed(self):
        """A failed write starts no cooldown, so the deferred set does not
        advance. Claiming it does reads a starvation as fairness working."""
        summary = self._summary_for([self._write_failure(1), self._deferred(2)])

        self.assertIn("do **not** rank first next run", summary)
        self.assertNotIn("so these rank first next run", summary)

    def test_the_rotation_guarantee_still_holds_when_every_write_landed(self):
        """Positive control. Without it, deleting the rotation clause
        outright would pass the test above while destroying the claim this
        PR exists to make true."""
        summary = self._summary_for([self._refired(1), self._deferred(2)])

        self.assertIn("so these rank first next run", summary)
        self.assertNotIn("do **not** rank first next run", summary)

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
        self.assertIn("1 were read in full and failed on the re-fire WRITE", summary)


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

    def test_the_default_is_still_twice_the_delivery_cap(self):
        module = self._reload_with(MAX_REFIRES_PER_RUN=7, MAX_REFIRE_ATTEMPTS_PER_RUN="")

        self.assertEqual(module.MAX_REFIRE_ATTEMPTS_PER_RUN, 14)


if __name__ == "__main__":
    unittest.main()

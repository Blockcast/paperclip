#!/usr/bin/env bash
# Canonical fleet merge-gate reader
# (BLO-26572 → BLO-34035 → BLO-34114 → BLO-34263 → BLO-34367 → BLO-37887).
#
# Reads BOTH check surfaces at a head and prints one line per row that is not a
# pass. Empty output means "nothing to stop on", and is trustworthy only because
# the END clause guarantees a line whenever NO surviving verdict was seen — so
# "clean" and "I could not see anything" are never the same output. Do not edit
# the pipeline without adding a fixture to merge-gate-read.test.mjs; every guard
# in here exists because a filter shipped a merge-authorizing false GREEN.
#
# NOT every line is a stop, and the mandated "any line out is a stop" reading
# gets a permanent false RED without this. Label column ($1):
#   STOP                 — blocking.
#   NOT-EVALUATED        — a `neutral` check: nothing attested this head. NOT
#                          blocking (BLO-34035), and not evidence of a review.
#   MALFORMED            — an un-expanded `${{` workflow template, i.e. a
#                          registration that can never report. NOT blocking.
# LOOKUP-FAILED is blocking but is NOT a label: require_sha's printf emits it
# in the CONCLUSION column ($3) under a $1 of STOP. A consumer filtering $1
# for blocking labels must match STOP and will never see it; listing it here
# as a label was wrong.
# NO-VERDICT (BLO-37887) is blocking and is likewise NOT a label, for exactly
# that reason: a run that has published nothing is ABSENT, and ABSENT is a stop
# under BLO-26572, so it MUST be caught by a `$1 == "STOP"` filter. It carries
# NO-VERDICT in the CONCLUSION column ($3) and names the workflow and the run
# state in $2, which is the distinguishability the remedy needs — that state is
# the run STATUS while it is in flight (`queued`, `pending`: WAIT for it) and the
# run CONCLUSION once it is completed (`startup_failure`, `action_required`: it
# will never report, so fix the workflow or approve the run and re-trigger).
# Either way you do not re-request a review. Promoting it to a $1 label would
# hide a real stop from every consumer following the mandated "any STOP line
# blocks the merge" reading. Direction of that mistake: GREEN.
#
# The VERDICT IS THE LINES, never $?. rc 1 IMPLIES the ABSENT line, but NOT the
# converse: `grep -v` returns 0 whenever any row survives, while the survivor
# count separately excludes App rows once anything was dropped — so an App-only
# survivor prints ABSENT at rc 0. Every head in this repo carries two App rows,
# so that is the common shape here, not a constructed one. rc is therefore a
# one-way signal at best. Never write `merge-gate-read.sh … && merge`.
#
#   merge-gate-read.sh <owner/repo> <sha|pr-head>     # live
#   merge-gate-read.sh --rows <DEAD> [PENDING]        # fixture mode, rows on stdin
#   merge-gate-read.sh --dead                         # fixture mode, runs on stdin
#   merge-gate-read.sh --pending                      # fixture mode, runs on stdin
#   merge-gate-read.sh --extract                      # fixture mode, check-run JSON on stdin
#   merge-gate-read.sh --status-extract               # fixture mode, status JSON on stdin
#   merge-gate-read.sh --runs-extract                 # fixture mode, runs JSON on stdin
#   merge-gate-read.sh --sha-guard <sha>              # fixture mode, validates one sha
#
# Row shape  (TSV): name <TAB> conclusion <TAB> timestamp <TAB> run-id|app:<slug>|status
# Run shape  (TSV): workflow-id <TAB> event <TAB> run-id <TAB> conclusion <TAB>
#                   run-started-at <TAB> status <TAB> workflow-name
# Pend shape (TSV): run-id <TAB> status-or-conclusion <TAB> workflow-name
set -uo pipefail

extract() { # stdin: check-runs API body (one object per page) -> stdout: rows
  # `.details_url // ""` guards capture(), which RAISES on null rather than
  # returning no match. jq aborts mid-stream on the raise, so one nullable
  # details_url silently truncates every check-run after it. details_url is
  # nullable in the REST schema and is set by whichever App published the run,
  # not by this repo. Failure direction is toward GREEN.
  # The fallback carries `.app.slug`, not a constant: a constant collapses the
  # name+run dedup key (the `seen` filter below) to name-only for every
  # App-published row, which is exactly
  # the masking BLO-34114 fixed for the workflow lanes.
  jq -r '.check_runs[]|[.name,(.conclusion // .status),(.completed_at // .started_at // "-"),
                        ((.details_url // "" | capture("runs/(?<r>[0-9]+)").r)
                         // ("app:" + (.app.slug // "?")))]|@tsv'
}

status_extract() { # stdin: commit-status API body (one object per page) -> rows
  jq -r '.statuses[]|[.context,.state,.updated_at,"status"]|@tsv'
}

run_extract() { # stdin: actions/runs API body (one object per page) -> run rows
  # Field ORDER is the contract with dead_runs(); a transposition here is
  # invisible at runtime and silently empties DEAD. @tsv renders a null as the
  # empty string, which dead_runs() treats as "no timestamp" and fails CLOSED.
  # status/name are APPENDED, never interleaved: dead_runs() reads $1..$5 and a
  # 5-field fixture row must keep meaning what it meant.
  jq -r '.workflow_runs[]|[.workflow_id,.event,.id,.conclusion,.run_started_at,
                           .status,.name]|@tsv'
}

pending_runs() { # stdin: run rows -> stdout: pend rows for runs owing a verdict
  # BLO-37887. A workflow run that has dispatched ZERO JOBS publishes ZERO
  # check-runs, so it is invisible on BOTH surfaces this reader fetches — there
  # is no row to keep, drop, or label. Measured at Network-Operator-Portal#1105
  # @ 0897b91d: run 36563730733 (Go Unit Tests) sat `status: pending` with
  # `jobs: 0` and appeared in NONE of the ~10 check-run rows at that head, while
  # every other run there had >=1 job and did appear.
  #
  # DEAD does not cover it: DEAD holds runs a later same-lane success
  # SUPERSEDED, which is a different question from "did this run publish". The
  # BLO-34263 survivor guard does not fire either — it is written for "DEAD
  # matched everything" and stays quiet while ~10 unrelated rows survive.
  # Neither existing guard can express "a run here has published nothing".
  #
  # The hazard is the WINDOW, not a steady state: while other runs are still red
  # the reader correctly stops. It fails GREEN in the interval where every
  # VISIBLE stop clears and a zero-job run is still outstanding — the reader
  # prints nothing, which BLO-26572 reads as "no stop", over a workflow that has
  # produced no verdict at all. Self-closing (that run dispatched jobs minutes
  # later and became visible), which is exactly why it has never been caught on
  # a settled head and why its fixtures must be synthetic.
  #
  # How the state is MANUFACTURED, and why this is worth a guard rather than a
  # note: the sanctioned draft->ready toggle creates it. The 11:45:30Z toggle on
  # that PR cancelled run 36556420221 under `cancel-in-progress`, and the
  # replacement was created 3s later and sat pre-dispatch. The mandated
  # per-workflow in-flight check ran first and predicted the cancellation
  # exactly. Two correct procedures composing into a blind spot neither has
  # alone.
  #
  # NEGATE, never match a literal state. The documented status domain is queued /
  # in_progress / completed / requested / waiting / pending; matching `pending`
  # alone passes the measured fixture and silently admits every other
  # pre-dispatch state plus any GitHub adds later. That is this file's own
  # recurring defect — BLO-34367 exists because `cancelled` was keyed on without
  # asking what the whole enum could mean.
  #
  # `completed` is NOT the whole answer, and reading it as one was the first cut
  # of this guard. A run can reach `completed` having published nothing at all,
  # and it is then invisible for exactly the reason above. Measured at
  # onprem-k8s @ b763c490: 28 runs, 23 published 57 check-runs between them and
  # 5 concluded `startup_failure` publishing ZERO — one of them `review-gate`.
  # The reader printed two lines there, both unrelated legacy statuses, so in
  # the window where those two clear the head reads merge-clean over five
  # workflows that produced no verdict. Direction GREEN. Raised by @ally on
  # #2112 and reproduced exactly as reported.
  #
  # So discriminate on "owes nothing", which is the conclusion, not the status:
  # `success` and `skipped` are the two that settle a run. Every other
  # conclusion — startup_failure / action_required / timed_out / stale /
  # cancelled / failure / neutral — leaves a workflow with no verdict published,
  # and a terminally-cancelled or failed run that published nothing is the same
  # BLO-34367 hole arrived at from the other side. Keep `== success` and
  # `== skipped` exact for the same reason dead_runs() keeps its own test exact:
  # anything looser lets a non-verdict settle a run.
  #
  # A superseded run is completed, non-success and publishes nothing HERE — its
  # rows are stripped by the DEAD grep before `contributed` is ever set — so it
  # would emit a spurious NO-VERDICT. It is excluded in the END loop of
  # verdicts(), NOT here: pending_runs() does not know DEAD, and doing it in the
  # caller would put the guard outside `--rows` fixture reach. Direction of
  # missing it is RED, but it breaks BLO-34114s own pinned control.
  #
  # That exclusion covers only the two conclusions dead_runs() admits as a
  # victim, `cancelled`/`failure` — the other five emitted here fall through it
  # and still print. See the third accepted residual in dead_runs() for the
  # measurement and for why widening the victim test is refused.
  #
  # A missing status or conclusion ("" via @tsv on a null, or a short fixture
  # row) is not `completed`/`success`, so it is kept and STOPs. Fails CLOSED, on
  # the same grounds as the missing-timestamp rule in dead_runs(): an absent
  # field must never be read as evidence that a verdict exists.
  #
  # The displayed state is the CONCLUSION once a run is completed. "run
  # completed, no check-run published" tells a reader to wait for something that
  # will never arrive; "run startup_failure" names the actual remedy, which is to
  # fix the workflow file and re-run, not to wait.
  #
  # `$3 != ""` is the blank-line fence and is load-bearing on the live path: the
  # reader pipes a shell variable in, and an empty variable arrives as one blank
  # line whose $6 is "" — i.e. not `completed` — which would print a NO-VERDICT
  # naming no workflow at all on every head that has no runs.
  awk -F'\t' '$3 != "" && !($6 == "completed" && ($4 == "success" || $4 == "skipped")) {
                s = ($6 == "completed" ? $4 : $6)
                print $3 "\t" (s == "" ? "?" : s) "\t" $7 }'
}

require_sha() { # $1 = candidate -> stdout: a STOP line + rc 1 when not 40-hex
  # `gh api` prints its error body to STDOUT, so a failed lookup makes H a JSON
  # blob rather than empty. Without this the malformed URL fails both later
  # calls and the reader reports ABSENT — misattributing a LOOKUP failure to an
  # absent surface, the one distinction the ABSENT wording exists to preserve.
  case "$1" in
    *[!0-9a-f]* | "") ;;
    ????????????????????????????????????????) return 0 ;;
  esac
  printf 'STOP\t<could not resolve a 40-hex commit sha>\tLOOKUP-FAILED\trun=-\n'
  return 1
}

dead_runs() { # stdin: run rows -> stdout: alternation of stale run ids
  # BLO-34367: `cancelled` conflates two run shapes GitHub reports identically.
  #   SUPERSEDED  — cancel-in-progress killed it, a newer run took over. Stale,
  #                 drop it, else its dead rows are a false RED (BLO-34114).
  #   TERMINAL    — a job hit timeout-minutes, or someone cancelled the run, and
  #                 nothing replaced it. That job produced NO VERDICT, which is a
  #                 STOP. Dropping it is a merge-authorizing false GREEN.
  #
  # BLO-34619: supersession was proxied through `max run id == the survivor`.
  # Run ids are monotonic, so that reads as sound, but when a workflow fires
  # SEVERAL runs at one head in the same second the concurrency arbiter's
  # survivor is NOT reliably the highest id. Measured on trafficcontrol#1870 @
  # 39e233c3: four `review-gate` runs at 00:04:03-04Z, and the survivor is the
  # THIRD of four (35408039808, success) while max id 35408039945 is a 0-second
  # casualty. Max-id was spared as "newest", so its cancelled row printed STOP —
  # and the real `success` row was dropped as stale. False RED, and the genuine
  # verdict discarded with it. The BLO-34263 survivor guard cannot catch it:
  # eight other workflows survived, so `n` is non-zero. That guard fires on
  # "kept nothing"; this is "kept the wrong one".
  #
  # So ask the API the question instead of proxying it through id ordering: a
  # cancelled run is stale iff a SIBLING run concluded `success` AND THAT
  # SUCCESS STARTED AT OR AFTER THE CANCELLED RUN DID.
  #
  # The temporal half is not decoration. Supersession is DIRECTIONAL in time —
  # cancel-in-progress kills the incumbent when a LATER run enters the group —
  # while sibling-success is a set membership test with no direction at all.
  # Without ordering, a success that ran BEFORE the cancellation deletes it, so
  # a lane that passed at 10:29 and was terminally cancelled at 11:19 reads
  # green (measured: trafficcontrol @ be0a7003, lane 323092531/issue_comment).
  # Long-lived `issue_comment` lanes accumulate hundreds of runs at one head, so
  # an older success is the common case there, not an exotic one. Direction of
  # the un-ordered failure is GREEN, which is why it is a guard and not a taste.
  #
  # `>=`, NOT `>`. run_started_at is SECOND-resolution and a concurrency burst
  # lands inside one second: on trafficcontrol#1870 @ 39e233c3 the surviving
  # success starts 00:04:04 and two of its three casualties start 00:04:04 too.
  # Under `>` both are retained and BLO-34619 re-opens as a false RED. A later
  # "tightening" to `>` is the obvious-looking cleanup; the fixture is the fence.
  #
  # A sibling is same workflow AND SAME EVENT. Dropping `event` from the key is
  # the tempting simplification and it re-opens BLO-34114 in the run dimension:
  # `pull_request` and `pull_request_target` are frequently ONE workflow file,
  # hence one workflow_id, fanning out to two concurrent lanes with identical
  # check-run names and opposite verdicts — and the failing lane is the
  # SECRETS-BEARING one, because the `pull_request` lane cannot reach secrets and
  # passes vacuously. Without `event`, a terminally-cancelled secrets lane is
  # deleted by the vacuous lane's success and `secret-scan` reads green.
  # Keeping `event` is not a claim that one event is one lane — `pull_request`
  # covers opened/synchronize/ready_for_review/labeled, so two runs sharing an
  # event are two attempts in TIME. That is precisely why the ordering above is
  # needed on top of it; the two terms guard different dimensions.
  # Cost of keeping `event`: a run genuinely cancelled by a different-event run
  # of the same workflow stays a STOP. That false RED is ACCEPTED, on the same
  # grounds as the one pinned in the test file — it costs a wait, the widening
  # costs a merge-authorizing false GREEN.
  #
  # `== "success"` is exact, and must stay exact. Relaxing it to `!= "cancelled"`
  # lets a `failure` sibling — or a vacuously-`skipped` lane — delete a terminal
  # cancellation, which is this file's whole failure mode. A missing timestamp on
  # either side fails CLOSED (the run is kept, i.e. STOP): an absent field must
  # never be read as evidence that a verdict exists. `started[i] != ""` is the
  # WHOLE fence for that, and it is killable. NEITHER side takes a second
  # `!= ""`: on the entry side "" can never win a max, and on the END side an
  # unset newest_pass already loses `>=` against any ISO timestamp, so it fails
  # closed on its own. A `newest_pass[grp[i]] != ""` term shipped here
  # through BLO-34619 and was deleted on review — all 52 tests stayed green with
  # it removed, i.e. it was a comment wearing the costume of code, the same
  # shape this paragraph rejects on the entry side.
  # That deletion does NOT rest on the string/numeric compare mode, which was the
  # reviewer's stated reason and is the weaker argument: an unset newest_pass
  # loses `>=` against an ISO timestamp under BOTH readings — as strings
  # "" < "2026-…", and numerically 0 < ("2026-…"+0) == 2026. It fails closed
  # either way, so a CONVFMT or awk-implementation change cannot flip it. The
  # outcome is asserted behaviourally by "keeps every run of a workflow whose
  # lane never passed", which is the lane-with-no-success shape.
  # `n=0` in BEGIN is load-bearing: an uninitialised awk variable is the empty
  # STRING, and array subscripts are strings, so the first cancelled row would
  # land at id[""] while the END loop reads id[0] — silently dropping one run
  # from DEAD. Direction: RED, but it is the same class of defect as the rest of
  # this file and a fixture caught it.
  # BLO-34835: the VICTIM predicate covers `failure` as well as `cancelled`.
  # These are the two halves of this test and only one of them is fenced above:
  # `== "success"` governs which run may SUPERSEDE and must stay exact; the
  # victim test governs which run may BE superseded, and restricting it to
  # `cancelled` was a permanent false RED. One head, one lane, two runs: a
  # `pull_request` re-trigger at the SAME head (`edited`, `labeled`,
  # `ready_for_review`, `reopened` — all the cheap metadata actions) leaves the
  # older run's `failure` rows behind forever, and the head never moves to clear
  # them. Measured on Open-Capacity-Marketplace#261 @ c1a6cd76: workflow
  # 328360353 ran twice, 35545233196 failure 23:38:21Z then 35545277556 success
  # 23:39:15Z after a title edit, and the reader printed a STOP nobody could
  # clear. ~3% of sampled open-PR heads across five repos carry the shape.
  #
  # Knowingly out of scope, not an oversight: GitHub's other terminal run
  # conclusions — `timed_out`, `startup_failure`, `stale`, `action_required`.
  # A superseded run in one of those still prints STOP, i.e. the same false RED
  # this widening fixed. Left alone because the direction is RED (costs a wait,
  # never a bad merge) and because none has been measured at a real head here,
  # unlike `failure`. Widen the predicate when one is; do not widen on theory.
  #
  # BEWARE the field this keys on: `workflow_run.event` is the WEBHOOK event
  # (`pull_request`), NOT the action (`opened`/`edited`). The originating report
  # read the actions and concluded the two runs were different events; they are
  # ONE lane, which is precisely why this is in scope and the cross-event cases
  # below are not. Read `.event`, never the action, before reasoning about lanes.
  #
  # Widening the victim does NOT widen the lane. Both cross-event controls stay
  # empty under it, measured: penstock fbdb3477 (BLO-34114's own control) and the
  # pull_request_target -> pull_request_review pair pinned in the test file. The
  # further widening to "any non-newest run of this workflow" is the one that was
  # implemented and REVERTED — it deletes across events, which is BLO-34114's
  # masking in the run dimension. Victim widening and lane widening are different
  # changes; only the first is safe.
  #
  # Residual, accepted and NOT fixable by a name-matched variant: if a later
  # same-lane run SKIPS the job that failed — a job gated on
  # `github.event.action` or on a label, e.g. paperclip's storybook-visual.yml,
  # which fires `pull_request` on [opened, reopened, synchronize, labeled] with
  # the job behind a label test — that run concludes `success` and republishes
  # the name as `skipped`, which passes. So a label change can turn a red lane
  # green. A per-name supersession test does not help, because the name IS
  # republished. This is "latest state wins", which is also what GitHub's own
  # required-check evaluation does; it is documented here so the next reader does
  # not mistake it for an oversight in this filter.
  # That equivalence holds ONLY when the superseding same-lane run republishes
  # every check-run name. Deletion here is per RUN, not per NAME, so it is a
  # proxy for "latest state wins" that the code assumes unconditionally.
  # Second residual, accepted: a `failure` victim whose rows include a name the
  # later same-lane `success` run never republished (narrowed matrix,
  # event-conditional job set) loses that verdict with no replacement. Unlike
  # the `skipped` case above, GitHub's latest state for that context is still
  # failure, so the direction is GREEN, not "latest state wins". Measured shape:
  # runs 111 failure / 222 success in one pull_request lane -> DEAD=111; rows
  # test-b failure only in run 111 -> verdicts() prints nothing, rc=0. A
  # per-name test WOULD help here (keep a `failure` victim's rows whose name no
  # later same-lane run republished) and is deliberately not implemented:
  # dead_runs() never sees names, so it would move the `failure` half of the
  # victim decision into verdicts(). How often a later same-lane run drops a
  # name at one head is unmeasured; the mechanism is proven, the frequency is
  # not.
  # Third residual, accepted: THE VICTIM TEST BELOW IS NARROWER THAN THE SET
  # verdicts() EXEMPTS WITH IT, and the reuse is deliberately partial. This
  # admits a victim only on `cancelled`/`failure`, while pending_runs() emits
  # every conclusion outside `success`/`skipped`. So a run superseded by a later
  # same-lane success whose conclusion is `startup_failure` / `timed_out` /
  # `stale` / `action_required` / `neutral`, and which published nothing, is in
  # the pend set, is NOT in DEAD, and prints a spurious NO-VERDICT for a lane
  # that demonstrably spoke. Measured: runs 111 <conclusion> / 222 success in one
  # pull_request lane -> `cancelled`/`failure` give DEAD=111 and print nothing;
  # the other five give DEAD='' and print NO-VERDICT run=111.
  # These two sets were disjoint by construction until BLO-37887 widened
  # pending_runs() off `$6 != "completed"` onto the conclusion, so this is new
  # surface, not a pre-existing residual. Direction is RED — it costs a wait,
  # never a merge — and it was not found in the wild: 0 occurrences across 24
  # heads (12 merged + 12 open, paperclip / onprem-k8s / Network-Operator-Portal).
  # Mechanism proven, frequency not established, same footing as the two above.
  # The fix is NOT to widen the victim test to match: every conclusion added here
  # deletes more runs, which is the merge-authorizing direction, and would buy a
  # measured-zero false RED with an unmeasured false GREEN. If it is ever seen in
  # the wild, widen the exemption in verdicts() instead — recompute it from the
  # pend set so verdicts() prints FEWER spurious lines, rather than widening what
  # dead_runs() deletes.
  awk -F'\t' 'BEGIN { n = 0 }   # n MUST be seeded: implicit is "" , not 0
              { key = $1 FS $2
                if ($4 == "success" && $5 > newest_pass[key]) newest_pass[key] = $5
                if ($4 == "cancelled" || $4 == "failure") {
                  id[n] = $3; grp[n] = key; started[n] = $5; n++ } }
              END { for (i = 0; i < n; i++)
                      if (started[i] != "" \
                          && newest_pass[grp[i]] >= started[i]) print id[i] }' \
    | sort -n | paste -sd'|' -
}

verdicts() { # $1 = DEAD alternation, $2 = PENDING rows (both may be empty)
  # Normalised HERE and nowhere else — the live path pipes dead_runs() straight
  # in, and it prints nothing when no run is stale. An empty alternation is not
  # inert: `()` is an empty sub-expression, which GNU grep reads as "matches
  # empty" (so `-vE "\t()$"` eats every row with an empty last field) and ugrep
  # rejects outright as a regex error, emptying the pipeline. Either way `dead`
  # then misses the `__none__` arm below, the App-row exclusion engages, and
  # ABSENT misreports nothing-dropped as everything-dropped.
  local dead="${1:-}"
  [ -z "$dead" ] && dead=__none__
  grep -vE "	(${dead})$" \
    | sort -t$'\t' -k1,1 -k4,4 -k3,3r \
    | awk -F'\t' '!seen[$1 FS $4]++' \
    | PEND="${2:-}" awk -F'\t' -v dead="$dead" '
        # NO APOSTROPHES anywhere below: this awk program is single-quoted in the
        # surrounding shell, so one inside a comment ends the script mid-word and
        # bash reports a syntax error on an unrelated line further down.
        #
        # BLO-37887. Pend rows are carried as an ORDERED list, not an
        # associative array: awk for-in order is unspecified, so iterating the
        # map directly makes multi-run output nondeterministic and its fixture
        # flaky. Keyed lookup still uses `contributed`, which is a map.
        #
        # Read from ENVIRON, NOT `-v pend=`: awk un-escapes a `-v` value, and a
        # workflow name carrying a real tab or newline reaches us from `@tsv` as
        # the two-character `\t`/`\n`. Round-tripping through `-v` turns those
        # back into real separators, so a tab truncates the displayed name and a
        # newline splits one run into two, emitting a spurious extra NO-VERDICT.
        # Direction is RED — `prid` is field 1, so a real stop can never be
        # suppressed — but the line then names a workflow that does not exist.
        BEGIN{ np = split(ENVIRON["PEND"], pl, "\n"); k = 0
               for (i = 1; i <= np; i++) if (pl[i] != "") {
                 split(pl[i], f, "\t")
                 # `--paginate` can repeat a run id when a run is created mid-walk
                 # and shifts the page boundary. Idempotent, so one line per run.
                 if (f[1] in pseen) continue
                 pseen[f[1]] = 1; k++
                 prid[k] = f[1]; pstat[k] = f[2]; pname[k] = f[3] } }
        NF==0{next}
        # Set on SURVIVING rows only — after DEAD, after dedup — so "contributed"
        # means "this run published a check-run that is still standing", which is
        # the question. Set BEFORE the label rules below so a row that is itself a
        # STOP still counts as its run having spoken.
        #
        # The two exclusions are the SAME predicate the survivor count `n` uses,
        # and they must stay aligned: `neutral` and a `${{`-bearing name are the
        # two declared NON-verdicts here, both explicitly non-blocking. Crediting
        # one as "this run spoke" suppresses NO-VERDICT for a run that has said
        # nothing — the fail-GREEN class this guard exists to close, one row away
        # from itself. `status`/`app:` rows need no exclusion: `$4` there is
        # literal `status` or `app:<slug>`, never a numeric `actions/runs[].id`,
        # so they cannot collide with a pend key.
        $2!="neutral"&&$1!~/\$\{\{/{contributed[$4] = 1}
        # Survivors are check-run verdicts only. On a repo that publishes ONLY
        # legacy statuses this fires ABSENT on every head — the documented
        # single-surface false RED. Control: run the same read against 3-8
        # commits that demonstrably shipped; empty there too means that surface
        # carries no verdict and the other one is the whole gate.
        # App-published rows are excluded on the SAME grounds as status rows,
        # but only when something was dropped: they are not workflow verdicts,
        # so one green App row otherwise suppresses the guard after DEAD ate
        # every real check-run, and the reader prints nothing. Every head in
        # this repo carries two such rows, and `gate/ally-comment-findings` is
        # `success` whenever there are no unresolved findings. The
        # `dead=="__none__"` arm keeps an App-only head from a false RED.
        # A name containing `${{` is an un-expanded workflow template, i.e. a
        # malformed registration that can never report. It is the ONE carve-out
        # from the stop rule in the mandated procedure, and the only part of that
        # procedure this script did not implement — so an affected repo
        # got a permanent false RED and every consumer re-derived the exception
        # by hand. Labelled, not dropped, exactly like `neutral`; and it is not a
        # verdict, so it does not count toward the survivor total either.
        $4!="status"&&$2!="neutral"&&$1!~/\$\{\{/&&(dead=="__none__"||$4!~/^app:/){n++}
        $2!="success"&&$2!="skipped"{print ($1~/\$\{\{/?"MALFORMED":($2=="neutral"?"NOT-EVALUATED":"STOP"))"\t"$1"\t"$2"\trun="$4}
        END{if(!n) print "STOP\t<" (dead!="__none__" \
              ? "every check-run at this head dropped as superseded-run" \
              : "no check-run verdict at this head") ">\tABSENT\trun=-"
            # A run that contributed NOTHING is owed a verdict this reader cannot
            # see. It does NOT count toward n: it is the absence of a verdict, so
            # counting it would suppress the very ABSENT guard that covers the
            # neighbouring case.
            #
            # DEAD runs are exempt, and the exemption is not cosmetic. A
            # superseded run is completed and non-success, so pending_runs()
            # emits it, and its rows were stripped by the grep at the top of this
            # function before `contributed` could be set — so without this it
            # prints NO-VERDICT for a run whose lane demonstrably spoke. The
            # alternation is reused verbatim rather than restated, on the same
            # grounds as the `contributed` predicate above: two encodings of one
            # question drift, and the drift reads correctly on each side alone.
            # The reuse is only PARTIAL, and deliberately so: dead_runs() admits
            # a victim on a narrower conclusion set than pending_runs() emits, so
            # five conclusions fall through this exemption. Third residual in
            # dead_runs() has the measurement and why widening it is refused.
            for (i = 1; i <= k; i++) if (!(prid[i] in contributed) \
                                         && prid[i] !~ ("^(" dead ")$"))
              printf "STOP\t<%s: run %s, no check-run published>\tNO-VERDICT\trun=%s\n", \
                     (pname[i] == "" ? "?" : pname[i]), pstat[i], prid[i]}'
}

# `--rows` propagates the pipeline status rather than swallowing it. Hardcoding
# `exit 0` here made the exit contract unobservable by construction, so no
# fixture could catch the header claiming an exactness it did not have.
if [ "${1:-}" = "--rows" ]; then verdicts "${2:-}" "${3:-}"; exit $?; fi
if [ "${1:-}" = "--dead" ]; then dead_runs; exit 0; fi
if [ "${1:-}" = "--pending" ]; then pending_runs; exit 0; fi
if [ "${1:-}" = "--extract" ]; then extract; exit 0; fi
if [ "${1:-}" = "--status-extract" ]; then status_extract; exit 0; fi
if [ "${1:-}" = "--runs-extract" ]; then run_extract; exit 0; fi
if [ "${1:-}" = "--sha-guard" ]; then require_sha "${2:-}"; exit $?; fi

R="$1"
# MANDATORY full 40-hex: actions/runs?head_sha= returns zero rows for an
# abbreviation, with no error, which silently empties DEAD (BLO-34114).
H=$(gh api "repos/$R/commits/$2" --jq .sha 2>/dev/null)
require_sha "$H" || exit 1

RUNS=$(gh api "repos/$R/actions/runs?head_sha=$H&per_page=100" --paginate \
        | run_extract)
# ZERO new API calls for BLO-37887: the runs body is already fetched, so the
# pending set is a second pass over rows in hand. Extract ONCE into RUNS and fan
# out; a second `gh api` here would double this reader's rate-limit cost on every
# invocation, and `gh` shares one installation token fleet-wide.
# An empty RUNS arrives as one blank line: dead_runs() matches nothing on it, and
# pending_runs()'s `$3 != ""` fence drops it.
DEAD=$(printf '%s\n' "$RUNS" | dead_runs)
PENDING=$(printf '%s\n' "$RUNS" | pending_runs)

# BOTH surfaces paginate. GitHub's default page size is 30, so an unpaginated
# status fetch silently drops the 31st context onward — and a dropped `failure`
# prints no STOP. The ABSENT guard cannot catch it: `$4!="status"` excludes
# status rows from the survivor count, so one surviving check-run keeps the guard quiet.
{ gh api "repos/$R/commits/$H/status?per_page=100" --paginate | status_extract
  gh api "repos/$R/commits/$H/check-runs?per_page=100" --paginate | extract
} | verdicts "$DEAD" "$PENDING"

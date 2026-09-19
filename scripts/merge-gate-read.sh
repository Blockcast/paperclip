#!/usr/bin/env bash
# Canonical fleet merge-gate reader
# (BLO-26572 → BLO-34035 → BLO-34114 → BLO-34263 → BLO-34367).
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
# LOOKUP-FAILED is blocking but is NOT a label: `:71` emits it in the CONCLUSION
# column ($3) under a $1 of STOP. A consumer filtering $1 for blocking labels
# must match STOP and will never see it; listing it here as a label was wrong.
#
# The VERDICT IS THE LINES, never $?. rc 1 IMPLIES the ABSENT line, but NOT the
# converse: `grep -v` returns 0 whenever any row survives, while the survivor
# count separately excludes App rows once anything was dropped — so an App-only
# survivor prints ABSENT at rc 0. Every head in this repo carries two App rows,
# so that is the common shape here, not a constructed one. rc is therefore a
# one-way signal at best. Never write `merge-gate-read.sh … && merge`.
#
#   merge-gate-read.sh <owner/repo> <sha|pr-head>     # live
#   merge-gate-read.sh --rows <DEAD-alternation>      # fixture mode, rows on stdin
#   merge-gate-read.sh --dead                         # fixture mode, runs on stdin
#   merge-gate-read.sh --extract                      # fixture mode, check-run JSON on stdin
#   merge-gate-read.sh --status-extract               # fixture mode, status JSON on stdin
#   merge-gate-read.sh --runs-extract                 # fixture mode, runs JSON on stdin
#   merge-gate-read.sh --sha-guard <sha>              # fixture mode, validates one sha
#
# Row shape  (TSV): name <TAB> conclusion <TAB> timestamp <TAB> run-id|app:<slug>|status
# Run shape  (TSV): workflow-id <TAB> event <TAB> run-id <TAB> conclusion <TAB> run-started-at
set -uo pipefail

extract() { # stdin: check-runs API body (one object per page) -> stdout: rows
  # `.details_url // ""` guards capture(), which RAISES on null rather than
  # returning no match. jq aborts mid-stream on the raise, so one nullable
  # details_url silently truncates every check-run after it. details_url is
  # nullable in the REST schema and is set by whichever App published the run,
  # not by this repo. Failure direction is toward GREEN.
  # The fallback carries `.app.slug`, not a constant: a constant collapses the
  # `:50` dedup key to name-only for every App-published row, which is exactly
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
  jq -r '.workflow_runs[]|[.workflow_id,.event,.id,.conclusion,.run_started_at]|@tsv'
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
  awk -F'\t' 'BEGIN { n = 0 }   # n MUST be seeded: implicit is "" , not 0
              { key = $1 FS $2
                if ($4 == "success" && $5 > newest_pass[key]) newest_pass[key] = $5
                if ($4 == "cancelled") {
                  id[n] = $3; grp[n] = key; started[n] = $5; n++ } }
              END { for (i = 0; i < n; i++)
                      if (started[i] != "" \
                          && newest_pass[grp[i]] >= started[i]) print id[i] }' \
    | sort -n | paste -sd'|' -
}

verdicts() { # $1 = DEAD alternation (empty or '__none__' when nothing is stale)
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
    | awk -F'\t' -v dead="$dead" 'NF==0{next}
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
              : "no check-run verdict at this head") ">\tABSENT\trun=-"}'
}

# `--rows` propagates the pipeline status rather than swallowing it. Hardcoding
# `exit 0` here made the exit contract unobservable by construction, so no
# fixture could catch the header claiming an exactness it did not have.
if [ "${1:-}" = "--rows" ]; then verdicts "${2:-}"; exit $?; fi
if [ "${1:-}" = "--dead" ]; then dead_runs; exit 0; fi
if [ "${1:-}" = "--extract" ]; then extract; exit 0; fi
if [ "${1:-}" = "--status-extract" ]; then status_extract; exit 0; fi
if [ "${1:-}" = "--runs-extract" ]; then run_extract; exit 0; fi
if [ "${1:-}" = "--sha-guard" ]; then require_sha "${2:-}"; exit $?; fi

R="$1"
# MANDATORY full 40-hex: actions/runs?head_sha= returns zero rows for an
# abbreviation, with no error, which silently empties DEAD (BLO-34114).
H=$(gh api "repos/$R/commits/$2" --jq .sha 2>/dev/null)
require_sha "$H" || exit 1

DEAD=$(gh api "repos/$R/actions/runs?head_sha=$H&per_page=100" --paginate \
        | run_extract | dead_runs)

# BOTH surfaces paginate. GitHub's default page size is 30, so an unpaginated
# status fetch silently drops the 31st context onward — and a dropped `failure`
# prints no STOP. The ABSENT guard cannot catch it: `:52` excludes status rows
# from the survivor count, so one surviving check-run keeps the guard quiet.
{ gh api "repos/$R/commits/$H/status?per_page=100" --paginate | status_extract
  gh api "repos/$R/commits/$H/check-runs?per_page=100" --paginate | extract
} | verdicts "$DEAD"

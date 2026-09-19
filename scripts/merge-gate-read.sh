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
#   merge-gate-read.sh <owner/repo> <sha|pr-head>     # live
#   merge-gate-read.sh --rows <DEAD-alternation>      # fixture mode, rows on stdin
#   merge-gate-read.sh --dead                         # fixture mode, runs on stdin
#   merge-gate-read.sh --extract                      # fixture mode, check-run JSON on stdin
#   merge-gate-read.sh --status-extract               # fixture mode, status JSON on stdin
#   merge-gate-read.sh --sha-guard <sha>              # fixture mode, validates one sha
#
# Row shape  (TSV): name <TAB> conclusion <TAB> timestamp <TAB> run-id|app:<slug>|status
# Run shape  (TSV): workflow-id <TAB> run-id <TAB> conclusion
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
  # Supersession is the property this filter always wanted, so test for it
  # directly: a cancelled run is stale only when a NEWER run of the same workflow
  # exists at this head. Run ids are monotonic, so `newest` == `max id`.
  sort -t$'\t' -k1,1 -k2,2nr \
    | awk -F'\t' '!newest[$1]++{next} $3=="cancelled"{print $2}' \
    | paste -sd'|' -
}

verdicts() { # $1 = DEAD alternation ('__none__' when nothing is stale)
  local dead="$1"
  grep -vE "	(${dead})$" \
    | sort -t$'\t' -k1,1 -k4,4 -k3,3r \
    | awk -F'\t' '!seen[$1 FS $4]++' \
    | awk -F'\t' -v dead="$dead" 'NF==0{next}
        # Survivors are check-run verdicts only. On a repo that publishes ONLY
        # legacy statuses this fires ABSENT on every head — the documented
        # single-surface false RED. Control: run the same read against 3-8
        # commits that demonstrably shipped; empty there too means that surface
        # carries no verdict and the other one is the whole gate.
        $4!="status"&&$2!="neutral"{n++}
        $2!="success"&&$2!="skipped"{print ($2=="neutral"?"NOT-EVALUATED":"STOP")"\t"$1"\t"$2"\trun="$4}
        END{if(!n) print "STOP\t<" (dead!="__none__" \
              ? "every check-run at this head dropped as superseded-run" \
              : "no check-run verdict at this head") ">\tABSENT\trun=-"}'
}

if [ "${1:-}" = "--rows" ]; then verdicts "${2:-__none__}"; exit 0; fi
if [ "${1:-}" = "--dead" ]; then dead_runs; exit 0; fi
if [ "${1:-}" = "--extract" ]; then extract; exit 0; fi
if [ "${1:-}" = "--status-extract" ]; then status_extract; exit 0; fi
if [ "${1:-}" = "--sha-guard" ]; then require_sha "${2:-}"; exit $?; fi

R="$1"
# MANDATORY full 40-hex: actions/runs?head_sha= returns zero rows for an
# abbreviation, with no error, which silently empties DEAD (BLO-34114).
H=$(gh api "repos/$R/commits/$2" --jq .sha 2>/dev/null)
require_sha "$H" || exit 1

DEAD=$(gh api "repos/$R/actions/runs?head_sha=$H&per_page=100" --paginate \
        --jq '.workflow_runs[]|[.workflow_id,.id,.conclusion]|@tsv' | dead_runs)
[ -z "$DEAD" ] && DEAD='__none__'

# BOTH surfaces paginate. GitHub's default page size is 30, so an unpaginated
# status fetch silently drops the 31st context onward — and a dropped `failure`
# prints no STOP. The ABSENT guard cannot catch it: `:52` excludes status rows
# from the survivor count, so one surviving check-run keeps the guard quiet.
{ gh api "repos/$R/commits/$H/status?per_page=100" --paginate | status_extract
  gh api "repos/$R/commits/$H/check-runs?per_page=100" --paginate | extract
} | verdicts "$DEAD"

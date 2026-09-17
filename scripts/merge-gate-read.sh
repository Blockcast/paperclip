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
#
# Row shape  (TSV): name <TAB> conclusion <TAB> timestamp <TAB> run-id|app|status
# Run shape  (TSV): workflow-id <TAB> run-id <TAB> conclusion
set -uo pipefail

extract() { # stdin: check-runs API body (one object per page) -> stdout: rows
  # `.details_url // ""` guards capture(), which RAISES on null rather than
  # returning no match — `// "app"` never sees it. jq aborts mid-stream on the
  # raise, so one nullable details_url silently truncates every check-run after
  # it. details_url is nullable in the REST schema and is set by whichever App
  # published the run, not by this repo. Failure direction is toward GREEN.
  jq -r '.check_runs[]|[.name,(.conclusion // .status),(.completed_at // .started_at // "-"),
                        (.details_url // "" | capture("runs/(?<r>[0-9]+)").r // "app")]|@tsv'
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
        $4!="status"&&$2!="neutral"{n++}
        $2!="success"&&$2!="skipped"{print ($2=="neutral"?"NOT-EVALUATED":"STOP")"\t"$1"\t"$2"\trun="$4}
        END{if(!n) print "STOP\t<" (dead!="__none__" \
              ? "every check-run at this head dropped as superseded-run" \
              : "no check-run verdict at this head") ">\tABSENT\trun=-"}'
}

if [ "${1:-}" = "--rows" ]; then verdicts "${2:-__none__}"; exit 0; fi
if [ "${1:-}" = "--dead" ]; then dead_runs; exit 0; fi
if [ "${1:-}" = "--extract" ]; then extract; exit 0; fi

R="$1"
# MANDATORY full 40-hex: actions/runs?head_sha= returns zero rows for an
# abbreviation, with no error, which silently empties DEAD (BLO-34114).
H=$(gh api "repos/$R/commits/$2" --jq .sha)

DEAD=$(gh api "repos/$R/actions/runs?head_sha=$H&per_page=100" --paginate \
        --jq '.workflow_runs[]|[.workflow_id,.id,.conclusion]|@tsv' | dead_runs)
[ -z "$DEAD" ] && DEAD='__none__'

{ gh api "repos/$R/commits/$H/status" \
    --jq '.statuses[]|[.context,.state,.updated_at,"status"]|@tsv'
  gh api "repos/$R/commits/$H/check-runs?per_page=100" --paginate | extract
} | verdicts "$DEAD"

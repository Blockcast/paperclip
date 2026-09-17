#!/usr/bin/env bash
# Canonical fleet merge-gate reader (BLO-26572 → BLO-34035 → BLO-34114 → BLO-34263).
#
# Reads BOTH check surfaces at a head and prints one line per row that is not a
# pass. Empty output means "nothing to stop on" — which is only trustworthy
# because of the END clause below. Do not edit the pipeline without adding a
# fixture to merge-gate-read.test.mjs; it has shipped three false-GREENs.
#
#   merge-gate-read.sh <owner/repo> <sha|pr-head>     # live
#   merge-gate-read.sh --rows <DEAD-alternation>      # fixture mode, rows on stdin
#
# Row shape (TSV): name <TAB> conclusion <TAB> timestamp <TAB> run-id|app|status
set -uo pipefail

verdicts() { # $1 = DEAD alternation ('__none__' when nothing was cancelled)
  local dead="$1"
  grep -vE "	(${dead})$" \
    | sort -t$'\t' -k1,1 -k4,4 -k3,3r \
    | awk -F'\t' '!seen[$1 FS $4]++' \
    | awk -F'\t' -v dead="$dead" '$4!="status"&&$2!="neutral"{n++}
        $2!="success"&&$2!="skipped"{print ($2=="neutral"?"NOT-EVALUATED":"STOP")"\t"$1"\t"$2"\trun="$4}
        END{if(!n && dead!="__none__") print "STOP\t<every check-run at this head dropped as cancelled-run>\tABSENT\trun=-"}'
}

if [ "${1:-}" = "--rows" ]; then verdicts "${2:-__none__}"; exit 0; fi

R="$1"
# MANDATORY full 40-hex: actions/runs?head_sha= returns zero rows for an
# abbreviation, with no error, which silently empties DEAD (BLO-34114).
H=$(gh api "repos/$R/commits/$2" --jq .sha)

DEAD=$(gh api "repos/$R/actions/runs?head_sha=$H&per_page=100" --paginate \
        --jq '.workflow_runs[]|select(.conclusion=="cancelled")|.id' | paste -sd'|' -)
[ -z "$DEAD" ] && DEAD='__none__'

{ gh api "repos/$R/commits/$H/status" \
    --jq '.statuses[]|[.context,.state,.updated_at,"status"]|@tsv'
  gh api "repos/$R/commits/$H/check-runs?per_page=100" --paginate \
    --jq '.check_runs[]|[.name,(.conclusion // .status),(.completed_at // .started_at // "-"),
                         (.details_url|capture("runs/(?<r>[0-9]+)").r // "app")]|@tsv'
} | verdicts "$DEAD"

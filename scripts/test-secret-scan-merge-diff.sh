#!/usr/bin/env bash
#
# Behavioural self-test for the `secret_scan` lane in .github/workflows/pr.yml
# (PEN-6245). It runs INSIDE that lane, against the same pinned gitleaks binary
# the scan uses, so it cannot drift away from what it pins.
#
# It exists because the two choices it covers are the ones that look correct
# while being inert if mis-edited, and neither shows up as a syntax error:
#
#   --diff-merges=remerge  On a pull_request the checked-out HEAD is GitHub's
#     merge ref. Plain `git log -p` omits merge commits entirely, so a secret
#     introduced by a CONFLICT RESOLUTION is scanned by nothing and the lane
#     goes green. Raw `-m` over-scans instead, emitting the base-side diff that
#     is outside the PR's range.
#
#   ^{commit}  in the range-readability guard. `git rev-parse --verify` accepts
#     a well-formed object NAME without checking the object exists, so an
#     ABSENT 40-hex sha -- exactly the shape of `base.sha` -- passes unpeeled
#     and fails peeled. Stripping the peel leaves the PEN-4087 guard inert
#     while it still READS correct. Ported from Blockcast/onprem-k8s#8493,
#     where that strip passed every assertion that existed at the time
#     (PEN-6227).
#
# Every value scanned below is assembled from fragments at runtime so this
# fixture is not itself a finding when the lane scans the PR that adds it.
set -euo pipefail

scanner=${1:?usage: $0 /path/to/gitleaks}
test -x "$scanner"

workflow="${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}/.github/workflows/pr.yml"

# Pin the literal invocation. A reworded comment is free; losing a flag is not.
# Each pin names itself on failure: a red whose output does not say WHICH
# mechanism went missing is a broken instrument, not a finding.
pin() { # literal  explanation
  grep -F "$1" "$workflow" >/dev/null && return 0
  echo "secret_scan lane no longer contains: $1" >&2
  echo "  why this is pinned: $2" >&2
  exit 1
}
pin 'args+=(--log-opts "--diff-merges=remerge ${PR_BASE_SHA}..HEAD")' \
  'without --diff-merges=remerge, a secret introduced by a merge resolution is scanned by nothing and the lane goes green'
pin 'git rev-parse --verify --quiet "${ref}^{commit}"' \
  'without the ^{commit} peel the PEN-4087 range guard accepts an absent 40-hex sha and the scan silently covers 0 commits'
pin 'args=(detect --source . --config .gitleaks.toml --redact --verbose --no-banner)' \
  'without --verbose gitleaks 8.28.0 prints only "leaks found: N" -- no file, line or rule -- so a red lane is unactionable'

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/secret-scan-merge-diff.XXXXXX")"
trap 'rm -rf "$work"' EXIT

new_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b master
  git -C "$dir" config user.email secret-scan-test@example.invalid
  git -C "$dir" config user.name secret-scan-test
  printf '%s\n' 'title = "merge-diff-test"' '' '[extend]' 'useDefault = true' > "$dir/.gitleaks.toml"
}

# Assembled at runtime, never written as a literal. Shaped to match gitleaks'
# `generic-api-key` rule (a keyword-bearing name plus an opaque value); it is
# locally generated and authenticates nothing.
fixture_value() { printf '%s%s%s' Bz8Qx9N2m7 K4p1L6 r3T5; }
fixture_line() { printf 'password = "%s"\n' "$(fixture_value)"; }

scan_range() { # repo base head -> exit code
  local repo="$1" base="$2" head="$3" code=0
  (
    cd "$repo"
    "$scanner" detect --source . --config .gitleaks.toml --redact --verbose --no-banner \
      --log-opts "--diff-merges=remerge ${base}..${head}" --exit-code 2
  ) >/dev/null 2>&1 || code=$?
  printf '%s' "$code"
}

# ---------------------------------------------------------------------------
# 1. The range guard's `^{commit}` peel. BOTH arms: a guard that refuses
#    everything is as broken as one that refuses nothing.
# ---------------------------------------------------------------------------
guard_repo="$work/guard"
new_repo "$guard_repo"
printf '%s\n' 'value=safe' > "$guard_repo/file.txt"
git -C "$guard_repo" add .
git -C "$guard_repo" commit -q -m base

for absent in 0000000000000000000000000000000000000000 \
              deadbeefdeadbeefdeadbeefdeadbeefdeadbeef; do
  if git -C "$guard_repo" rev-parse --verify --quiet "${absent}^{commit}" >/dev/null 2>&1; then
    echo "secret_scan range guard is INERT: absent sha ${absent} resolves through ^{commit}" >&2
    exit 1
  fi
done
git -C "$guard_repo" rev-parse --verify --quiet "$(git -C "$guard_repo" rev-parse HEAD)^{commit}" >/dev/null

# ---------------------------------------------------------------------------
# 2. A secret introduced by a MERGE RESOLUTION is seen only with
#    --diff-merges=remerge. Both arms asserted, so this cannot pass by the
#    scanner firing on everything.
# ---------------------------------------------------------------------------
merge_repo="$work/merge-resolution"
new_repo "$merge_repo"
printf '%s\n' 'value=safe' > "$merge_repo/secret.txt"
git -C "$merge_repo" add .
git -C "$merge_repo" commit -q -m base

git -C "$merge_repo" switch -q -c pr
printf '%s\n' 'value=pr-safe' > "$merge_repo/secret.txt"
git -C "$merge_repo" commit -q -am pr-change

git -C "$merge_repo" switch -q -c sync master
printf '%s\n' 'value=base-safe' > "$merge_repo/secret.txt"
git -C "$merge_repo" commit -q -am sync-change

git -C "$merge_repo" merge --no-commit pr >/dev/null 2>&1 || true
fixture_line > "$merge_repo/secret.txt"
git -C "$merge_repo" add secret.txt
git -C "$merge_repo" commit -q -m merge-resolution

merge_base="$(git -C "$merge_repo" rev-parse master)"
merge_head="$(git -C "$merge_repo" rev-parse HEAD)"

without_remerge=0
(
  cd "$merge_repo"
  "$scanner" detect --source . --config .gitleaks.toml --redact --verbose --no-banner \
    --log-opts "${merge_base}..${merge_head}" --exit-code 2
) >/dev/null 2>&1 || without_remerge=$?

test "$without_remerge" -eq 0 \
  || { echo "expected plain git log to MISS the merge resolution, got exit $without_remerge" >&2; exit 1; }
test "$(scan_range "$merge_repo" "$merge_base" "$merge_head")" -eq 2 \
  || { echo "--diff-merges=remerge did not catch a secret added by a merge resolution" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 3. A secret already on the BASE side is outside `<base>..HEAD`. A clean merge
#    in either direction must not make it look newly introduced -- otherwise
#    every PR opened while master carries one of the 74 documented whole-tree
#    false positives would go red for a line it did not touch.
# ---------------------------------------------------------------------------
base_repo="$work/base-side"
new_repo "$base_repo"
printf '%s\n' 'value=safe' > "$base_repo/unchanged.txt"
git -C "$base_repo" add .
git -C "$base_repo" commit -q -m base

git -C "$base_repo" switch -q -c pr
printf '%s\n' 'value=pr-safe' > "$base_repo/pr.txt"
git -C "$base_repo" add pr.txt
git -C "$base_repo" commit -q -m pr-change

git -C "$base_repo" switch -q -c sync master
fixture_line > "$base_repo/base-side-secret.txt"
git -C "$base_repo" add base-side-secret.txt
git -C "$base_repo" commit -q -m base-side-secret

git -C "$base_repo" merge --no-commit pr >/dev/null 2>&1
git -C "$base_repo" commit -q -m merge
test "$(scan_range "$base_repo" "$(git -C "$base_repo" rev-parse HEAD^1)" "$(git -C "$base_repo" rev-parse HEAD)")" -eq 0 \
  || { echo "a base-side secret outside the range was reported as newly introduced" >&2; exit 1; }

# The opposite merge direction: the PR branch merges an advanced base into
# itself.
git -C "$base_repo" switch -q -c pr-merges-base master
printf '%s\n' 'value=pr-safe' > "$base_repo/pr-merges-base.txt"
git -C "$base_repo" add pr-merges-base.txt
git -C "$base_repo" commit -q -m pr-merges-base-change

git -C "$base_repo" switch -q master
fixture_line > "$base_repo/base-source-secret.txt"
git -C "$base_repo" add base-source-secret.txt
git -C "$base_repo" commit -q -m base-source-secret
base_tip="$(git -C "$base_repo" rev-parse master)"

git -C "$base_repo" switch -q pr-merges-base
git -C "$base_repo" merge --no-commit master >/dev/null 2>&1
git -C "$base_repo" commit -q -m pr-merges-base
test "$(scan_range "$base_repo" "$base_tip" "$(git -C "$base_repo" rev-parse HEAD)")" -eq 0 \
  || { echo "merging an advanced base into the PR branch reported the base's secret" >&2; exit 1; }

echo "secret_scan merge-diff and range-guard contracts hold"

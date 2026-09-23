// Executable coverage for the bounded PR-check polling loops in
// .agents/skills/check-pr/SKILL.md and .agents/skills/prcheckloop/SKILL.md
// (BLO-31075).
//
// WHY THIS EXISTS
//   Those two files are agent-EXECUTED instructions, not prose. Before this
//   test the only verification was `bash -n`, which proves a block parses and
//   nothing about what it does. That gap is not academic: the first version of
//   the check-pr loop broke only on `gh pr checks` exit 0, so a PR with a
//   failing check polled for the full 15 minutes and reported a timeout, and
//   the prcheckloop block had no success exit at all — a green PR always ended
//   in exit 124. Both parsed cleanly.
//
// HOW IT WORKS
//   Each test extracts a fenced bash block from the skill by a marker unique to
//   that block, then runs it under `bash` with a stub `gh` (and, where timing
//   matters, a stub `sleep`) ahead of the real ones on PATH. The stub records
//   every invocation, so "did this loop even call gh pr checks?" is an
//   assertion rather than an inference.
//
//   Deadlines are driven to 0 rather than waited out: the loops measure elapsed
//   wall-clock with `date +%s`, so a 0-second deadline fires on the first pass
//   and the timeout paths run in milliseconds.
//
//   Where a test needs the loop to survive one pass and time out on a LATER
//   one, a 0-second deadline cannot express that and a small non-zero one is a
//   race — `date +%s` is integer-second, so "1" fires whenever the first pass
//   straddles a second boundary. Those tests pass `virtualClock: true`, which
//   fakes `date +%s` off a counter that only advances when the loop sleeps.
//   See the stub for the full rationale (BLO-31386).
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_PR_SKILL = path.join(repoRoot, ".agents/skills/check-pr/SKILL.md");
const PRCHECKLOOP_SKILL = path.join(repoRoot, ".agents/skills/prcheckloop/SKILL.md");

/** Every ```bash fenced block in a markdown file, in document order. */
function bashBlocks(file) {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/**
 * The single bash block containing `marker`. Selecting by content rather than
 * by index means reordering the prose cannot silently point this test at a
 * different block and turn it green against the wrong code.
 */
function blockContaining(file, marker) {
  const hits = bashBlocks(file).filter((b) => b.includes(marker));
  assert.equal(hits.length, 1, `expected exactly one bash block containing ${marker} in ${file}, got ${hits.length}`);
  return hits[0];
}

const CHECK_PR_LOOP = () => blockContaining(CHECK_PR_SKILL, "read_pr_state()");
const CHECK_PR_REAP = () => blockContaining(CHECK_PR_SKILL, "watch_pid=$!");
const CHECK_PR_GITLAB = () => blockContaining(CHECK_PR_SKILL, "mr_state=");
const PRCHECKLOOP_LOOP = () => blockContaining(PRCHECKLOOP_SKILL, "NO_CHECKS_DEADLINE_SEC");

/**
 * The executable blocks this suite owns. Deliberately NOT "every fenced block
 * in the file": several predate this work and are illustrative fragments with
 * `<PLACEHOLDER>` tokens (`p4 describe -s <CL_NUMBER>`) that are not valid
 * bash and were never meant to be run.
 */
const EXECUTABLE_BLOCKS = () => [
  ["check-pr polling loop", CHECK_PR_LOOP()],
  ["check-pr watcher reap", CHECK_PR_REAP()],
  ["check-pr GitLab loop", CHECK_PR_GITLAB()],
  ["prcheckloop polling loop", PRCHECKLOOP_LOOP()],
];

/**
 * A stub `gh` / `glab` (and optionally `sleep`) on a private PATH.
 *
 * `checksRc` / `prViewRc` are consumed one entry per call and the last entry
 * repeats, so a test can say "pending, then green" without racing anything.
 *
 * `virtualClock` additionally stubs `date +%s` — see the comment on the stub
 * itself for why any test with a single-digit deadline needs it.
 */
function makeStubs({
  prState = "OPEN ",
  prViewRc = [0],
  checksRc = [0],
  checkRunsJson = '{"check_runs":[]}',
  statusJson = '{"statuses":[]}',
  apiRc = [0],
  stubSleep = false,
  virtualClock = false,
  headShas = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  // GitLab side. `pipelineStatuses` is the newline-delimited output of
  // `glab api .../pipelines --jq '.[].status'`; [] means "no pipelines exist".
  mrState = "opened",
  mrStateRc = [0],
  pipelineStatuses = ["success"],
  pipelinesRc = [0],
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-stub-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(dir, "pr-view-rc"), prViewRc.join("\n") + "\n");
  writeFileSync(path.join(dir, "checks-rc"), checksRc.join("\n") + "\n");
  writeFileSync(path.join(dir, "api-rc"), apiRc.join("\n") + "\n");
  writeFileSync(path.join(dir, "check-runs.json"), checkRunsJson);
  writeFileSync(path.join(dir, "status.json"), statusJson);
  // Accepts a string (constant) or an array (one entry per call, last repeats)
  // so a test can flip the state mid-poll without patching the stub's source.
  writeFileSync(
    path.join(dir, "pr-state"),
    (Array.isArray(prState) ? prState : [prState]).join("\n") + "\n",
  );
  // Consumed one per `gh pr view --json headRefOid` call, last entry repeats —
  // so a test can move the head mid-poll.
  writeFileSync(path.join(dir, "head-shas"), headShas.join("\n") + "\n");
  writeFileSync(path.join(dir, "mr-state-rc"), mrStateRc.join("\n") + "\n");
  writeFileSync(path.join(dir, "pipelines-rc"), pipelinesRc.join("\n") + "\n");
  writeFileSync(path.join(dir, "mr-state"), mrState);
  writeFileSync(
    path.join(dir, "pipeline-statuses"),
    pipelineStatuses.length ? pipelineStatuses.join("\n") + "\n" : "",
  );

  // pop <file> — read the next line, leaving the last one in place so it
  // repeats for every subsequent call.
  const gh = `#!/usr/bin/env bash
d=${JSON.stringify(dir)}
printf '%s\\n' "gh $*" >>"$d/calls.log"
pop() {
  local f=$1 line
  line=$(head -n 1 "$f")
  if [[ $(wc -l <"$f") -gt 1 ]]; then tail -n +2 "$f" >"$f.tmp" && mv "$f.tmp" "$f"; fi
  printf '%s' "$line"
}
case "$1 $2" in
  "pr view")
    rc=$(pop "$d/pr-view-rc")
    if [[ $rc != 0 ]]; then echo "gh: could not resolve PR" >&2; exit "$rc"; fi
    # The head-SHA query and the state query are the same subcommand; tell them
    # apart by which --json fields were asked for.
    if [[ "$*" == *headRefOid* && "$*" != *state* ]]; then
      pop "$d/head-shas"; echo
    else
      pop "$d/pr-state"; echo
    fi
    exit 0
    ;;
  "pr checks")
    rc=$(pop "$d/checks-rc")
    case "$rc" in
      0) echo "some-check	pass	1s" ;;
      1) echo "some-check	fail	1s" ;;
      8) echo "some-check	pending	0s" ;;
    esac
    exit "$rc"
    ;;
esac
if [[ $1 == api ]]; then
  rc=$(pop "$d/api-rc")
  [[ $rc != 0 ]] && { echo "gh: API rate limit exceeded" >&2; exit "$rc"; }
  case "$2" in
    *check-runs*) cat "$d/check-runs.json" ;;
    *status*)     cat "$d/status.json" ;;
  esac
  exit 0
fi
echo "gh stub: unhandled: $*" >&2
exit 99
`;
  writeFileSync(path.join(bin, "gh"), gh);
  chmodSync(path.join(bin, "gh"), 0o755);

  // Same shape as the gh stub: log the call, pop a return code, print the
  // fixture. The two glab endpoints the GitLab loop touches are distinguished
  // by path suffix, so a test can assert the pipelines endpoint was never hit.
  const glab = `#!/usr/bin/env bash
d=${JSON.stringify(dir)}
printf '%s\\n' "glab $*" >>"$d/calls.log"
pop() {
  local f=$1 line
  line=$(head -n 1 "$f")
  if [[ $(wc -l <"$f") -gt 1 ]]; then tail -n +2 "$f" >"$f.tmp" && mv "$f.tmp" "$f"; fi
  printf '%s' "$line"
}
if [[ $1 == api ]]; then
  case "$2" in
    */pipelines)
      rc=$(pop "$d/pipelines-rc")
      [[ $rc != 0 ]] && { echo "glab: 500 Internal Server Error" >&2; exit "$rc"; }
      cat "$d/pipeline-statuses"
      exit 0
      ;;
    *)
      rc=$(pop "$d/mr-state-rc")
      [[ $rc != 0 ]] && { echo "glab: could not resolve MR" >&2; exit "$rc"; }
      cat "$d/mr-state"; echo
      exit 0
      ;;
  esac
fi
echo "glab stub: unhandled: $*" >&2
exit 99
`;
  writeFileSync(path.join(bin, "glab"), glab);
  chmodSync(path.join(bin, "glab"), 0o755);

  if (stubSleep || virtualClock) {
    // Records the requested duration and returns immediately, so the interval
    // floor is assertable without a test that actually sleeps a minute.
    //
    // Under `virtualClock` it ALSO advances the fake clock by the duration it
    // was asked to sleep. That is the whole seam: elapsed time becomes a pure
    // function of what the loop slept, not of how long the poll body happened
    // to take.
    //
    // The advance has a floor of one tick so that the clock moves even on
    // `sleep 0`. Without it, a loop whose clamp had been removed and whose
    // interval was 0 would advance time by 0 forever and hang until the
    // 30-second spawn timeout — the negative control would still fail, but as
    // an opaque timeout rather than "slept 0s, below the documented floor".
    // A real `sleep 0` also consumes a nonzero interval, so this is the more
    // faithful model as well as the more legible one.
    //
    // It also clears the `date` stub's consecutive-read counter, which is what
    // makes that counter mean "reads with no intervening sleep" rather than
    // "reads in total" — see the ceiling on the date stub below.
    const sleep = virtualClock
      ? `#!/usr/bin/env bash
d=${JSON.stringify(dir)}
printf '%s\\n' "$1" >>"$d/sleeps.log"
printf '0' >"$d/reads"
advance=$1; (( advance < 1 )) && advance=1
printf '%s' "$(( $(cat "$d/clock") + advance ))" >"$d/clock"
exit 0
`
      : `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >>${JSON.stringify(dir)}/sleeps.log\nexit 0\n`;
    writeFileSync(path.join(bin, "sleep"), sleep);
    chmodSync(path.join(bin, "sleep"), 0o755);
  }

  if (virtualClock) {
    // WHY (BLO-31386): the loops measure elapsed time as
    // `$(date +%s) - poll_started`, which is INTEGER-second arithmetic. Under
    // the real clock a 1-second deadline therefore fires whenever the first
    // poll pass happens to straddle a wall-clock second boundary. Its
    // probability is just the fraction of a second that pass occupies, so the
    // rate is load-DEPENDENT rather than a fixed property of the test: ~5%
    // (1/20) on a quiet sandbox, but 4-in-6 under induced CPU load. CI runners
    // are the loaded case, and CI is where this was first seen. Do not measure
    // this locally, get 5%, and conclude the note is stale.
    //
    // That made "deadline long enough for one sleep, then time out" a coin
    // flip: the loop exited 124 on the FIRST pass having slept zero times, and
    // the suite failed on `expected at least one sleep` on completely
    // unchanged code. Because the `policy` job is a hard merge gate, each
    // occurrence ejected an unrelated PR from the merge queue.
    //
    // Raising the deadline would only have made the coin flip rarer, not
    // removed it. Stubbing `date` removes it outright: this clock ONLY moves
    // when the loop sleeps, so wall-clock duration of the poll body — the
    // sole source of the nondeterminism — no longer enters the arithmetic.
    // "One sleep, then the next pass times out" becomes an arithmetic
    // certainty at any deadline below the clamped interval.
    //
    // The clamp assertion stays load-bearing: the recorded sleep argument is
    // still whatever the loop actually asked for, so dropping the 60s floor
    // still turns the test red.
    writeFileSync(path.join(dir, "clock"), "1000000000");
    const date = `#!/usr/bin/env bash
d=${JSON.stringify(dir)}
# Only +%s is faked; a non-epoch use falls through to the real date so an
# unrelated future use inside a skill block cannot silently read this clock.
#
# The fall-through is deliberately CLOSED to epoch reads, because matching
# only an exact \`+%s\` is asymmetric: it stops the fake clock leaking into
# unrelated \`date\` uses, but does nothing to stop an epoch read escaping the
# fake clock. A future \`date -u +%s\`, or any epoch read carrying a leading
# flag, would reach the REAL clock and silently reinstate the very race this
# stub exists to remove — no failure, just an intermittent merge-gating flake
# again. So an unhandled argument mentioning %s is a hard error: loud at the
# one site where silence was expensive (BLO-31386).
#
# The read counter is the same principle applied to the opposite escape. A
# clock that moves ONLY when the loop sleeps cannot time out a loop that never
# sleeps: \`elapsed\` stays 0, the deadline never fires, and the block spins
# until the 30s spawn timeout — so a regression that stopped the loop sleeping
# would surface as \`null !== 124\` instead of as the assertion that names it,
# which is precisely the diagnosability this file exists to restore. Past a
# ceiling of consecutive reads with no intervening sleep, jump the clock so the
# loop times out through its OWN deadline path and the suite fails fast on
# "expected at least one sleep" (3.3s rather than 30s).
#
# 20 is ~7x headroom: the counter resets on every sleep, and the highest any
# test here legitimately reaches is 3. It is deliberately not larger — the
# ceiling is also the number of wasted poll passes the failure costs, and 100
# took 16s to trip.
#
# Jumping the clock, rather than exiting nonzero, is what makes this work at
# all: the loops run WITHOUT \`set -e\`, so a failed \`date\` inside
# \`elapsed=\$(( \$(date +%s) - poll_started ))\` is swallowed and the spin
# continues — measured, it still timed out at 30s and merely added one stderr
# line per iteration.
#
# The jump is written BACK to the clock so it accumulates. A jump that only
# returned \`clock + 86400\` without persisting it would pin \`elapsed\` at
# exactly 86400 for read 21 and every read after it, so any deadline above a
# day would never be crossed and the ceiling would decay into the exact two
# behaviours rejected above — spin to the spawn timeout, one stderr line per
# pass. Measured on a reconstruction at a 90000s deadline: the non-cumulative
# form spun to the spawn timeout without ever reaching the loop's own deadline
# path, while the cumulative form exited THROUGH that path in ~0.5s with
# exactly 2 stderr lines — deterministically \`ceil(90000/86400)\`, not a
# timing artefact. The exit status is what tells those two apart, and it is
# the cheapest discriminator available: this harness runs no \`timeout\`(1) —
# \`runBlock\` is a bare \`spawnSync\` with \`timeout: 30_000\` — so a spawn-timeout
# kill reports \`status: null\` with \`SIGTERM\`/\`ETIMEDOUT\`, while reaching the
# loop's own deadline path exits \`124\`. That \`null\`-vs-\`124\` split is exactly
# what every \`assert.equal(r.status, 124)\` in this file rests on; see the same
# point made above about a loop that stops sleeping. The non-cumulative form's
# stderr line count is deliberately NOT quoted here: it is just how many
# iterations fit inside the 30s kill, so it is timing-dependent — machine
# speed AND load — and three runs of the same reconstruction gave 389, 1104
# and 1348, a 3.5x spread with the hardware held fixed. Do not re-measure it,
# get a different number, and conclude this note is stale. Past roughly 11k
# lines the 1 MiB default \`maxBuffer\` binds before the 30s kill does and the
# child dies \`ENOBUFS\` instead — also \`status: null\`, so the discriminator
# above holds in that regime too.
#
# No deadline in this file exceeds 900 today, so this buys nothing at this
# head; it is here so the ceiling stays a ceiling under a future edit rather
# than silently becoming deadline-dependent. Legitimate tests are untouched —
# they never reach read 4.
if [[ $1 == +%s ]]; then
  reads=$(( $(cat "$d/reads" 2>/dev/null || echo 0) + 1 ))
  printf '%s' "$reads" >"$d/reads"
  if (( reads > 20 )); then
    printf 'virtual clock stub: %s clock reads with no intervening sleep — the loop is not sleeping\\n' "$reads" >&2
    jumped=$(( $(cat "$d/clock") + 86400 ))
    printf '%s' "$jumped" >"$d/clock"
    printf '%s\\n' "$jumped"
    exit 0
  fi
  cat "$d/clock"; echo; exit 0
fi
for a in "$@"; do
  case $a in
    *%s*)
      printf 'virtual clock stub: unhandled epoch format: %s\\n' "$*" >&2
      exit 64
      ;;
  esac
done
# PATH is overridden so this stub cannot recurse into itself. The rest of the
# environment is inherited on purpose: \`env -i\` would also drop TZ and the
# locale, so a future non-epoch \`date\` would format in UTC/C under test and
# in the runner's zone in production — a divergence that would surface only as
# a mismatched formatted string.
exec /usr/bin/env PATH=/usr/bin:/bin date "$@"
`;
    writeFileSync(path.join(bin, "date"), date);
    chmodSync(path.join(bin, "date"), 0o755);
  }
  return { dir, bin };
}

function runBlock(block, { env = {}, stubs }) {
  return spawnSync("bash", ["-c", block], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${stubs.bin}:${process.env.PATH}`,
      PR_NUMBER: "1590",
      OWNER_REPO: "Blockcast/paperclip",
      MR_IID: "1",
      HEAD_SHA: "deadbeef",
      ...env,
    },
  });
}

const calls = (stubs) =>
  existsSync(path.join(stubs.dir, "calls.log"))
    ? readFileSync(path.join(stubs.dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean)
    : [];
const sleeps = (stubs) =>
  existsSync(path.join(stubs.dir, "sleeps.log"))
    ? readFileSync(path.join(stubs.dir, "sleeps.log"), "utf8").trim().split("\n").filter(Boolean)
    : [];

// ---------------------------------------------------------------------------
// Every block this suite owns must at least parse. Cheap, and it is what the
// PR originally claimed as its entire verification — kept, not relied on.
// ---------------------------------------------------------------------------
test("the executable skill blocks parse", () => {
  for (const [name, block] of EXECUTABLE_BLOCKS()) {
    const r = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
    assert.equal(r.status, 0, `${name} failed bash -n:\n${r.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// check-pr — the loop
// ---------------------------------------------------------------------------

test("check-pr: a failing check exits 1 immediately, not 124 after the deadline", () => {
  // The original regression. gh pr checks exits 1 when a check FAILED, which
  // the first implementation treated as "still pending".
  const stubs = makeStubs({ checksRc: [1] });
  const r = runBlock(CHECK_PR_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  assert.equal(r.status, 1, `expected 1, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.equal(calls(stubs).filter((c) => c.startsWith("gh pr checks")).length, 1, "should not have re-polled");
});

test("check-pr: no checks configured surfaces gh's stderr instead of failing silently", () => {
  const stubs = makeStubs({ checksRc: [1] });
  const r = runBlock(CHECK_PR_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gh exit 1/);
});

test("check-pr: all-green exits 0", () => {
  const stubs = makeStubs({ checksRc: [0] });
  const r = runBlock(CHECK_PR_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("check-pr: still-pending checks time out with 124", () => {
  const stubs = makeStubs({ checksRc: [8] });
  const r = runBlock(CHECK_PR_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "0" } });
  assert.equal(r.status, 124, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /Timed out/);
});

test("check-pr: a merged PR exits 3 without ever polling checks", () => {
  const stubs = makeStubs({ prState: "MERGED 2026-09-01T00:00:00Z" });
  const r = runBlock(CHECK_PR_LOOP(), { stubs });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.equal(
    calls(stubs).filter((c) => c.startsWith("gh pr checks")).length,
    0,
    "a settled PR must not start a check watch at all",
  );
});

test("check-pr: a closed-unmerged PR exits 4, distinguishable from green", () => {
  const stubs = makeStubs({ prState: "CLOSED " });
  const r = runBlock(CHECK_PR_LOOP(), { stubs });
  assert.equal(r.status, 4, `${r.stdout}${r.stderr}`);
});

test("check-pr: a PR that merges mid-poll stops on the next iteration", () => {
  // Open on the pre-flight read, merged on the in-loop re-read. Driven by the
  // stub's state SEQUENCE — an earlier version of this test rewrote the stub's
  // source with a string replace, which silently stopped flipping the state
  // when that line was refactored and left the test timing out at 60s instead
  // of failing.
  const stubs = makeStubs({
    checksRc: [8],
    prState: ["OPEN ", "MERGED 2026-09-01T00:00:00Z"],
    stubSleep: true,
  });
  const r = runBlock(CHECK_PR_LOOP(), {
    stubs,
    env: { CHECK_DEADLINE_SEC: "900", CHECK_INTERVAL_SEC: "60" },
  });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
});

test("check-pr: a failed gh pr view exits 1 rather than proceeding as if open", () => {
  const stubs = makeStubs({ prViewRc: [1] });
  const r = runBlock(CHECK_PR_LOOP(), { stubs });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.equal(calls(stubs).filter((c) => c.startsWith("gh pr checks")).length, 0);
});

test("check-pr: a sub-minute interval is clamped to 60s", () => {
  const stubs = makeStubs({ checksRc: [8, 0], stubSleep: true });
  const r = runBlock(CHECK_PR_LOOP(), {
    stubs,
    env: { CHECK_DEADLINE_SEC: "900", CHECK_INTERVAL_SEC: "1" },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepEqual(sleeps(stubs), ["60"], "a 1s interval must be raised to the 60s floor");
});

test("check-pr: a non-numeric deadline is rejected with 2, not silently treated as 0", () => {
  const stubs = makeStubs();
  const r = runBlock(CHECK_PR_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "abc" } });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /must be a non-negative integer/);
});

test("check-pr: the reap snippet captures the watcher PID in the same shell", () => {
  // The published snippet declared watch_pid='' and never assigned it, so
  // cleanup_watch could never fire — the exact leak BLO-31075 exists to close.
  const reap = CHECK_PR_REAP();
  assert.match(reap, /watch_pid=\$!/, "the child PID must be captured with $! in the same shell");
  const loop = CHECK_PR_LOOP();
  assert.match(loop, /kill "\$watch_pid"/, "the EXIT trap must terminate the captured PID");
});

test("check-pr: exactly one EXIT trap is installed across the section", () => {
  // `trap` replaces rather than appends; the published version installed
  // `trap 'rm -f "$checks_output"' EXIT INT TERM` and then
  // `trap cleanup_watch EXIT`, silently dropping the temp-file cleanup.
  //
  // The pattern must tolerate a quoted handler containing spaces — an earlier
  // draft used \S+ for the handler, which could not match that first line and
  // so reported "1 EXIT trap" for code that had two.
  const blocks = [CHECK_PR_LOOP(), CHECK_PR_REAP(), CHECK_PR_GITLAB()];
  const exitTraps = blocks.flatMap((b) => b.split("\n").filter((l) => /^\s*trap\b.*\bEXIT\b/.test(l)));
  assert.equal(exitTraps.length, 1, `expected one EXIT trap, found ${exitTraps.length}: ${JSON.stringify(exitTraps)}`);
});

test("check-pr: INT and TERM handlers exit rather than only cleaning up", () => {
  // bash resumes execution after a non-default handler returns, so a handler
  // that only removes the temp file leaves the loop running and recreates it.
  const loop = CHECK_PR_LOOP();
  assert.match(loop, /trap\s+'exit 130'\s+INT/);
  assert.match(loop, /trap\s+'exit 143'\s+TERM/);
});

test("check-pr: the loop bounds itself on wall clock, not $SECONDS", () => {
  // $SECONDS restarts per shell, so a block split across tool calls would
  // never reach its own deadline.
  const loop = CHECK_PR_LOOP();
  assert.ok(!/\bSECONDS\b/.test(loop), "must not bound on $SECONDS");
  assert.match(loop, /date \+%s/);
});

// ---------------------------------------------------------------------------
// prcheckloop — the loop
// ---------------------------------------------------------------------------

const GREEN_RUNS = '{"check_runs":[{"status":"completed","conclusion":"success"}]}';
const PENDING_RUNS = '{"check_runs":[{"status":"in_progress","conclusion":null}]}';
const FAILED_RUNS = '{"check_runs":[{"status":"completed","conclusion":"failure"}]}';
const NO_STATUSES = '{"statuses":[]}';

test("prcheckloop: an all-green PR exits 0 instead of polling to the deadline", () => {
  // The published block had no success exit at all: its only break was
  // merged/closed, so a green PR always ended in exit 124.
  const stubs = makeStubs({ checkRunsJson: GREEN_RUNS, statusJson: NO_STATUSES });
  const r = runBlock(PRCHECKLOOP_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("prcheckloop: a failed check run exits 1", () => {
  const stubs = makeStubs({ checkRunsJson: FAILED_RUNS, statusJson: NO_STATUSES });
  const r = runBlock(PRCHECKLOOP_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
});

test("prcheckloop: a failed status context exits 1", () => {
  const stubs = makeStubs({
    checkRunsJson: '{"check_runs":[]}',
    statusJson: '{"statuses":[{"state":"failure","context":"ci/legacy"}]}',
  });
  const r = runBlock(PRCHECKLOOP_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
});

test("prcheckloop: an unknown check-run conclusion is NOT green", () => {
  // Fail closed. Counting only the KNOWN failures leaves an unrecognized
  // conclusion in neither `pending` nor `failed`, and "not pending and not
  // failed" is the green path — so a conclusion GitHub adds after this was
  // written would be reported as SUCCESS by a script whose entire job is to
  // not do that.
  const stubs = makeStubs({
    checkRunsJson:
      '{"check_runs":[{"name":"ci","status":"completed","conclusion":"exploded"}]}',
    statusJson: NO_STATUSES,
  });
  const r = runBlock(PRCHECKLOOP_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  // The operator has to be able to tell "this script is out of date" from
  // "CI is red", so the message names the value.
  assert.match(r.stderr, /exploded/);
});

test("prcheckloop: an unknown status-context state is NOT green", () => {
  const stubs = makeStubs({
    checkRunsJson: '{"check_runs":[]}',
    statusJson: '{"statuses":[{"state":"weird","context":"ci/legacy"}]}',
  });
  const r = runBlock(PRCHECKLOOP_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /weird/);
});

test("prcheckloop: an unknown non-completed check-run status is NOT green", () => {
  // The pending side needs the same treatment: `status` is enumerated too, so
  // an unrecognized non-terminal value must not silently count as pending
  // either — polling on it would just burn the deadline and report a timeout.
  const stubs = makeStubs({
    checkRunsJson: '{"check_runs":[{"name":"ci","status":"hibernating"}]}',
    statusJson: NO_STATUSES,
  });
  const r = runBlock(PRCHECKLOOP_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /hibernating/);
});

test("prcheckloop: every documented success state still reaches exit 0", () => {
  // Discriminator for the three above: fail-closed is only correct if the
  // DOCUMENTED terminal-success states still pass. neutral and skipped are
  // easy to drop when enumerating.
  const stubs = makeStubs({
    checkRunsJson: JSON.stringify({
      check_runs: [
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "completed", conclusion: "neutral" },
        { name: "c", status: "completed", conclusion: "skipped" },
      ],
    }),
    statusJson: '{"statuses":[{"state":"success","context":"ci/legacy"}]}',
  });
  const r = runBlock(PRCHECKLOOP_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("prcheckloop: every documented pending state keeps polling", () => {
  // Same discriminator on the pending side: queued/in_progress/waiting/
  // requested must still be pending, or the loop exits 1 on a healthy PR
  // whose checks simply have not started.
  for (const status of ["queued", "in_progress", "waiting", "requested"]) {
    const stubs = makeStubs({
      checkRunsJson: JSON.stringify({ check_runs: [{ name: "ci", status }] }),
      statusJson: NO_STATUSES,
    });
    const r = runBlock(PRCHECKLOOP_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "0" } });
    assert.equal(r.status, 124, `${status}: ${r.stdout}${r.stderr}`);
  }
});

test("prcheckloop: pending work times out with 124", () => {
  const stubs = makeStubs({ checkRunsJson: PENDING_RUNS, statusJson: NO_STATUSES });
  const r = runBlock(PRCHECKLOOP_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "0" } });
  assert.equal(r.status, 124, `${r.stdout}${r.stderr}`);
});

test("prcheckloop: no checks at all exits 5, distinct from green", () => {
  const stubs = makeStubs({ checkRunsJson: '{"check_runs":[]}', statusJson: NO_STATUSES });
  const r = runBlock(PRCHECKLOOP_LOOP(), {
    stubs,
    env: { CHECK_DEADLINE_SEC: "900", NO_CHECKS_DEADLINE_SEC: "0" },
  });
  assert.equal(r.status, 5, `${r.stdout}${r.stderr}`);
});

test("prcheckloop: a failed gh api call is not classified as green", () => {
  // An empty result satisfies "every item is terminal" vacuously, so an API
  // failure must fail loudly rather than fall through to success.
  const stubs = makeStubs({ apiRc: [1] });
  const r = runBlock(PRCHECKLOOP_LOOP(), {
    stubs,
    env: { CHECK_DEADLINE_SEC: "900", NO_CHECKS_DEADLINE_SEC: "0" },
  });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /not treating that as "no checks"/);
});

test("prcheckloop: a merged PR exits 3 without querying checks", () => {
  const stubs = makeStubs({ prState: "MERGED 2026-09-01T00:00:00Z" });
  const r = runBlock(PRCHECKLOOP_LOOP(), { stubs });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.equal(calls(stubs).filter((c) => c.startsWith("gh api")).length, 0);
});

test("prcheckloop: a sub-minute interval is clamped to 60s", () => {
  const stubs = makeStubs({ checkRunsJson: PENDING_RUNS, statusJson: NO_STATUSES, virtualClock: true });
  const r = runBlock(PRCHECKLOOP_LOOP(), {
    stubs,
    // Deadline shorter than the clamped interval, on a clock that only moves
    // when the loop sleeps: pass 1 sees elapsed 0 and sleeps, that sleep
    // advances the clock past the deadline, pass 2 times out. Deterministic
    // rather than a race against wall-clock second boundaries (BLO-31386).
    env: { CHECK_DEADLINE_SEC: "1", CHECK_INTERVAL_SEC: "5" },
  });
  assert.equal(r.status, 124, `${r.stdout}${r.stderr}`);
  assert.ok(sleeps(stubs).length >= 1, "expected at least one sleep");
  assert.deepEqual([...new Set(sleeps(stubs))], ["60"], "a 5s interval must be raised to the 60s floor");
});

test("prcheckloop: gh pr view is scoped with --repo", () => {
  // Without --repo, gh resolves from the cwd's git remote and can report the
  // state of a different repository than the one being polled.
  const stubs = makeStubs({ checkRunsJson: GREEN_RUNS, statusJson: NO_STATUSES });
  runBlock(PRCHECKLOOP_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
  const view = calls(stubs).find((c) => c.startsWith("gh pr view"));
  assert.ok(view, "expected a gh pr view call");
  assert.match(view, /--repo Blockcast\/paperclip/);
});

test("prcheckloop: uses per-invocation temp files, not shared /tmp paths", () => {
  // Two agents polling different PRs on the same host would otherwise
  // classify each other's results.
  const loop = PRCHECKLOOP_LOOP();
  assert.ok(!/>\s*\/tmp\/check-runs\.json/.test(loop), "must not write a fixed /tmp path");
  assert.match(loop, /mktemp -d/);
});

test("prcheckloop: bounds itself on wall clock, not $SECONDS", () => {
  const loop = PRCHECKLOOP_LOOP();
  assert.ok(!/\bSECONDS\b/.test(loop), "must not bound on $SECONDS");
  assert.match(loop, /date \+%s/);
});

// ---------------------------------------------------------------------------
// Anti-regression: no unbounded --watch anywhere in either skill.
// ---------------------------------------------------------------------------

test("no executable block runs an unbounded gh pr checks --watch", () => {
  // Scoped to the fenced blocks, not the file: the prose deliberately names
  // the anti-pattern ("Never start an unbounded `gh pr checks --watch`"), and
  // a guard that fires on its own warning label would have to be deleted.
  for (const [name, block] of EXECUTABLE_BLOCKS()) {
    for (const line of block.split("\n")) {
      if (!/gh pr checks[^\n]*--watch/.test(line)) continue;
      // The one permitted use is the backgrounded child whose PID is captured
      // for the reap trap on the same line.
      assert.match(
        line,
        /&\s*watch_pid=\$!/,
        `${name}: --watch must be backgrounded with its PID captured, got: ${line.trim()}`,
      );
    }
  }
});

test("jq is available for the prcheckloop classifier", () => {
  // The loop's success exit depends on jq; a host without it would fall
  // through to the deadline, which is the bug this test suite exists to stop.
  assert.doesNotThrow(() => execFileSync("jq", ["--version"], { stdio: "ignore" }));
});

// ---------------------------------------------------------------------------
// GitLab loop. The finding these cover: the loop previously tested for
// running/pending and then only for failed/canceled, so `manual`, `scheduled`,
// and anything GitLab adds later landed in NEITHER bucket — and "not pending
// and not failed" is the green path.
// ---------------------------------------------------------------------------

const GL_ENV = { MR_IID: "42", CHECK_DEADLINE_SEC: "900", CHECK_INTERVAL_SEC: "60" };

function runGitLab(opts, env = {}) {
  const stubs = makeStubs(opts);
  return { stubs, r: runBlock(CHECK_PR_GITLAB(), { stubs, env: { ...GL_ENV, ...env } }) };
}

test("check-pr GitLab: a manual pipeline is NOT green", () => {
  // The headline case. A pipeline parked on a manual gate is terminal until a
  // human clicks play — it is neither success nor something a longer deadline
  // fixes.
  const { r } = runGitLab({ pipelineStatuses: ["manual"] });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /manual/);
});

test("check-pr GitLab: a scheduled pipeline is NOT green", () => {
  const { r } = runGitLab({ pipelineStatuses: ["scheduled"] });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /scheduled/);
});

test("check-pr GitLab: an unknown pipeline status is NOT green", () => {
  const { r } = runGitLab({ pipelineStatuses: ["teleported"] });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  // Name the value, so "this script is out of date" stays distinguishable
  // from "CI is red".
  assert.match(r.stderr, /teleported/);
});

test("check-pr GitLab: a manual pipeline alongside successes is still NOT green", () => {
  // The realistic shape: most jobs pass and one deploy stage waits on a human.
  // A loop that only asks "is anything running?" reports this as green.
  const { r } = runGitLab({ pipelineStatuses: ["success", "success", "manual"] });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /manual/);
});

test("check-pr GitLab: an empty pipeline list is NOT green", () => {
  // "Every pipeline is terminal and green" is vacuously true over zero
  // pipelines, which is the one answer this loop must never invent.
  const { r } = runGitLab({ pipelineStatuses: [] });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
});

test("check-pr GitLab: every documented success state reaches exit 0", () => {
  // Discriminator. Fail-closed is only correct if the documented green states
  // still pass; `skipped` is the easy one to drop when enumerating.
  const { r } = runGitLab({ pipelineStatuses: ["success", "skipped"] });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("check-pr GitLab: every documented pending state keeps polling", () => {
  // Discriminator on the pending side: these must NOT be swept into the fatal
  // arm, or the loop exits 1 on a healthy MR whose pipeline has not started.
  for (const status of ["created", "waiting_for_resource", "preparing", "pending", "running"]) {
    const { r } = runGitLab({ pipelineStatuses: [status] }, { CHECK_DEADLINE_SEC: "0" });
    assert.equal(r.status, 124, `${status}: ${r.stdout}${r.stderr}`);
  }
});

test("check-pr GitLab: a failed pipeline exits 1", () => {
  const { r } = runGitLab({ pipelineStatuses: ["failed"] });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
});

test("check-pr GitLab: a merged MR returns 3 without querying pipelines", () => {
  // Asserting the pipelines endpoint was never hit, not just the exit code —
  // the point of the lifecycle guard is to not start polling at all.
  const { stubs, r } = runGitLab({ mrState: "merged" });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  const calls = readFileSync(path.join(stubs.dir, "calls.log"), "utf8");
  assert.ok(!calls.includes("/pipelines"), `queried pipelines anyway:\n${calls}`);
});

test("check-pr GitLab: a closed MR returns 4", () => {
  const { r } = runGitLab({ mrState: "closed" });
  assert.equal(r.status, 4, `${r.stdout}${r.stderr}`);
});

test("check-pr GitLab: a failed pipelines query is not treated as green", () => {
  const { r } = runGitLab({ pipelinesRc: [1] });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
});

test("check-pr GitLab: a failed MR-state query is not treated as open", () => {
  const { r } = runGitLab({ mrStateRc: [1] });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
});

test("check-pr GitLab: rejects non-numeric config instead of evaluating it", () => {
  // The block is reached standalone — it is the GitLab branch of the
  // instructions — so "validated as above" left this path unguarded and fed
  // caller-supplied text straight into `(( ))`, which is arithmetic
  // EVALUATION, not a comparison.
  for (const bad of ["abc", "9;echo pwned", "-1", "1.5", " 9"]) {
    const { r } = runGitLab({}, { CHECK_DEADLINE_SEC: bad });
    assert.equal(r.status, 2, `CHECK_DEADLINE_SEC=${JSON.stringify(bad)}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /pwned/);
  }
  for (const bad of ["abc", "x"]) {
    const { r } = runGitLab({}, { CHECK_INTERVAL_SEC: bad });
    assert.equal(r.status, 2, `CHECK_INTERVAL_SEC=${JSON.stringify(bad)}: ${r.stdout}${r.stderr}`);
  }
});

test("check-pr GitLab: an EMPTY config value means unset, and defaults", () => {
  // Not a rejection case, and worth pinning so a future tightening of the
  // regex above does not turn `CHECK_DEADLINE_SEC=` into a hard exit 2. An
  // empty environment variable is indistinguishable from an absent one, so
  // `${VAR:-default}` is the correct reading.
  const { r } = runGitLab({ pipelineStatuses: ["success"] }, { CHECK_DEADLINE_SEC: "", CHECK_INTERVAL_SEC: "" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("check-pr GitLab: clamps a sub-minute interval to the 60s floor", () => {
  // CHECK_INTERVAL_SEC=0 would busy-loop against the GitLab API at whatever
  // rate the network allows — the unbounded polling this skill exists to
  // remove, reintroduced through a missing clamp. Asserted via the recorded
  // sleep argument rather than by waiting a minute.
  const stubs = makeStubs({ pipelineStatuses: ["running"], virtualClock: true });
  const r = runBlock(CHECK_PR_GITLAB(), {
    stubs,
    // Same virtual-clock reasoning as the prcheckloop clamp test above. This
    // site failed differently — the loop exited before the sleep stub had
    // created sleeps.log at all, so it died in readFileSync with ENOENT
    // rather than on the assertion, which is why grepping CI for the
    // assertion text did not find it (BLO-31386). The read below now goes
    // through the guarded `sleeps()` helper, so if this ever regresses again
    // it fails on the assertion that says what went wrong instead of
    // reproducing that same opaque ENOENT.
    env: { ...GL_ENV, CHECK_DEADLINE_SEC: "1", CHECK_INTERVAL_SEC: "0" },
  });
  assert.equal(r.status, 124, `${r.stdout}${r.stderr}`);
  const slept = sleeps(stubs);
  assert.ok(slept.length > 0, "the loop never slept, so the clamp is untested");
  for (const s of slept) assert.equal(s, "60", `slept ${s}s, below the documented floor`);
});

test("prcheckloop: re-reads the head each iteration and queries the NEW sha", () => {
  // Ally's finding: HEAD_SHA was captured once in step 2 and never refreshed,
  // so a concurrent push left the loop querying the OLD commit — whose checks
  // are already terminal — and reporting it green while claiming to have
  // inspected the latest head.
  const OLD = "1111111111111111111111111111111111111111";
  const NEW = "2222222222222222222222222222222222222222";
  const stubs = makeStubs({
    headShas: [OLD, NEW],
    checkRunsJson: '{"check_runs":[{"name":"ci","status":"in_progress"}]}',
    statusJson: NO_STATUSES,
    virtualClock: true,
  });
  const r = runBlock(PRCHECKLOOP_LOOP(), {
    stubs,
    // Virtual clock (BLO-31386): reaching the NEW sha requires a second pass,
    // so under the real clock this shared the 1-second-deadline race and could
    // exit 124 on pass 1 having never queried it — a third symptom of the same
    // root cause ("never queried the new sha"), distinct from the other two.
    env: { HEAD_SHA: OLD, CHECK_DEADLINE_SEC: "1", CHECK_INTERVAL_SEC: "60" },
  });
  assert.equal(r.status, 124, `${r.stdout}${r.stderr}`);
  const calls = readFileSync(path.join(stubs.dir, "calls.log"), "utf8");
  // The whole point: it must have gone on to query the new commit.
  assert.ok(calls.includes(`commits/${NEW}/check-runs`), `never queried the new sha:\n${calls}`);
  assert.match(r.stdout, /Head moved/);
});

test("prcheckloop: a stable head is not reported as moving", () => {
  // Discriminator: if the refresh were comparing against the wrong thing it
  // would announce a move on every iteration, restart the clock forever, and
  // never reach the deadline.
  const SHA = "3333333333333333333333333333333333333333";
  const stubs = makeStubs({
    headShas: [SHA],
    checkRunsJson: '{"check_runs":[{"name":"ci","status":"in_progress"}]}',
    statusJson: NO_STATUSES,
    stubSleep: true,
  });
  const r = runBlock(PRCHECKLOOP_LOOP(), {
    stubs,
    env: { HEAD_SHA: SHA, CHECK_DEADLINE_SEC: "0", CHECK_INTERVAL_SEC: "60" },
  });
  assert.equal(r.status, 124, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /Head moved/);
});

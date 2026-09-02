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
 * A stub `gh` (and optionally `sleep`) on a private PATH.
 *
 * `checksRc` / `prViewRc` are consumed one entry per call and the last entry
 * repeats, so a test can say "pending, then green" without racing anything.
 */
function makeStubs({
  prState = "OPEN ",
  prViewRc = [0],
  checksRc = [0],
  checkRunsJson = '{"check_runs":[]}',
  statusJson = '{"statuses":[]}',
  apiRc = [0],
  stubSleep = false,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-stub-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(dir, "pr-view-rc"), prViewRc.join("\n") + "\n");
  writeFileSync(path.join(dir, "checks-rc"), checksRc.join("\n") + "\n");
  writeFileSync(path.join(dir, "api-rc"), apiRc.join("\n") + "\n");
  writeFileSync(path.join(dir, "check-runs.json"), checkRunsJson);
  writeFileSync(path.join(dir, "status.json"), statusJson);
  writeFileSync(path.join(dir, "pr-state"), prState);

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
    if [[ $rc == 0 ]]; then cat "$d/pr-state"; echo; else echo "gh: could not resolve PR" >&2; fi
    exit "$rc"
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

  if (stubSleep) {
    // Records the requested duration and returns immediately, so the interval
    // floor is assertable without a test that actually sleeps a minute.
    const sleep = `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >>${JSON.stringify(dir)}/sleeps.log\nexit 0\n`;
    writeFileSync(path.join(bin, "sleep"), sleep);
    chmodSync(path.join(bin, "sleep"), 0o755);
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
  // Open on the pre-flight read, merged on the in-loop re-read.
  const stubs = makeStubs({ checksRc: [8], prState: "OPEN " });
  writeFileSync(path.join(stubs.dir, "pr-state"), "OPEN ");
  // Flip the state file after the first pr view call by making the stub's
  // second read see MERGED: simplest is a sequence-aware state file.
  const gh = readFileSync(path.join(stubs.bin, "gh"), "utf8").replace(
    'if [[ $rc == 0 ]]; then cat "$d/pr-state"; echo;',
    'if [[ $rc == 0 ]]; then n=$(cat "$d/n" 2>/dev/null || echo 0); echo $((n+1)) >"$d/n"; ' +
      'if [[ $n -ge 1 ]]; then echo "MERGED 2026-09-01T00:00:00Z"; else cat "$d/pr-state"; echo; fi;',
  );
  writeFileSync(path.join(stubs.bin, "gh"), gh);
  chmodSync(path.join(stubs.bin, "gh"), 0o755);
  const r = runBlock(CHECK_PR_LOOP(), { stubs, env: { CHECK_DEADLINE_SEC: "900" } });
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
  const stubs = makeStubs({ checkRunsJson: PENDING_RUNS, statusJson: NO_STATUSES, stubSleep: true });
  const r = runBlock(PRCHECKLOOP_LOOP(), {
    stubs,
    // Deadline long enough for one sleep, then the second pass times out.
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

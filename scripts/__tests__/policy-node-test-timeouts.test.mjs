import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflowSource = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

// Scope: pr.yml only, of 31 workflow files. The invariant the chart-suite
// assertions below encode ("the suite runs in exactly one job") is really
// repo-wide, so a re-add in e2e.yml or master-health.yml is invisible here.
// Deliberate rather than overlooked: pr.yml is where both historical duplicates
// landed (#965, #995), and today no other workflow references the suite at all
// -- docker.yml renders the chart four times but never runs its tests. Widen
// this to a glob over .github/workflows/ if that stops being true.

// Every assertion here matches pr.yml as text, so all of them have to ignore
// comments. pr.yml documents these invariants in prose inside itself -- the
// `helm_chart` preamble names the suite's directory and says "do not re-add it
// here" -- and counting a sentence about a rule as an instance of breaking it
// makes documenting the rule in the obvious place turn this file red. Only
// whole-line comments are stripped: `run:` bodies legitimately contain `#`
// (`"${#failed[@]}"`), and mangling those would trade one false signal for
// another. Comment bodies are blanked in place rather than deleted so every
// byte offset still lines up with the real file.
const workflow = workflowSource.replace(/^[ \t]*#.*$/gm, (line) => " ".repeat(line.length));

function policySteps() {
  const start = workflow.indexOf("\n  policy:\n");
  const end = workflow.indexOf("\n  helm_chart:\n", start);
  assert.notEqual(start, -1, "pr.yml must define policy");
  assert.notEqual(end, -1, "pr.yml must define helm_chart after policy");
  return workflow.slice(start, end).split("\n      - name: ").slice(1);
}

function nodeTestSteps() {
  return policySteps().filter((step) => step.includes("node --test"));
}

function assertTimeouts(steps) {
  assert.ok(steps.length > 0, "policy must contain node --test steps");
  for (const step of steps) {
    assert.match(step, /\n        timeout-minutes: 1\n/, "each policy node --test step must have a one-minute bound");
  }
}

test("every policy node --test step has a step-level timeout", () => {
  assertTimeouts(nodeTestSteps());
});

test("the timeout guard fails when a node --test bound is removed", () => {
  const mutated = nodeTestSteps().map((step) => step.replace("\n        timeout-minutes: 1\n", "\n"));
  assert.throws(() => assertTimeouts(mutated), /one-minute bound/);
});

test("policy continues after a bounded test failure unless cancelled", () => {
  const steps = policySteps();
  const firstNodeTest = steps.findIndex((step) => step.includes("node --test"));
  assert.notEqual(firstNodeTest, -1, "policy must contain a node --test step");
  for (const step of steps.slice(firstNodeTest + 1)) {
    assert.match(step, /\n        if: \$\{\{ !cancelled\(\)/, "later policy steps must continue after a test failure");
  }
});

// BLO-31405. The chart render suite forks `helm template` once per test file, so
// under the one-minute default asserted above its p100 of 73s (25 sampled runs)
// failed `policy` on duration alone — skipping every lane that `needs:` it, on
// PRs that never touched the chart. It belongs to the dedicated `helm_chart`
// job, which has a 10-minute budget and is itself a `verify` lane.
//
// It had already landed in both places at once: #965 added the policy step and
// #995 added the job, each comment claiming the tests "ran nowhere in CI". A
// note saying "do not re-add" would not have stopped that, because neither
// author read the other's file. So gate it, in both directions — exactly one
// invocation, owned by exactly that job. Deleting the coverage outright fails
// this too, which is the mistake that motivated the duplicate in the first
// place.
// Match the suite's DIRECTORY, not the `*.test.mjs` glob it happens to be
// invoked with today. The glob is one spelling of many: re-adding the step as
// `node --test ./deploy/helm/paperclip/tests/probes.test.mjs` restores the
// duplicate coverage while leaving a glob-only search at exactly one hit, so
// the gate passes and the thing it exists to catch goes through.
//
// What the directory buys, precisely: any re-add that names the path from the
// repo root -- individual files, a bare directory WITH its trailing slash, a
// leading `./` -- including one inside a `run: |` block, which filtering to
// `run:` lines would miss (pr.yml has 17 such blocks). Drop that slash and the
// text match does escape, so `node --test ./deploy/helm/paperclip/tests` looks
// like a hole; it is not one, because Node resolves a positional argument as a
// module path and never searches it as a directory. Measured on the pinned
// `node-version: 24` (pr.yml:483): both spellings die with
// `code: 'MODULE_NOT_FOUND'` and exit 1, reported as one failing test. So the
// gap is real in the matcher and inert in practice -- and inert in the loud
// direction, which is why it is left alone: that spelling cannot reintroduce
// coverage silently, it can only break the step that tries.
//
// What it does NOT catch is a re-add where the
// path never appears in full, and that has two independent causes, not one:
// chdir'ing first, and a glob wide enough that the directory is never spelled.
// Both pass the assertion below. The next two assertions close one each -- the
// chdir one, then the house-style one that keeps globs narrow.
//
//     run: |                              working-directory: deploy/helm/paperclip
//       cd deploy/helm/paperclip          run: node --test ./tests/*.test.mjs
//       node --test ./tests/*.test.mjs
//
//     run: node --test ./deploy/helm/*/tests/*.test.mjs
// One path, spelled once. These two constants encode the same thing -- the
// chart root a chdir lands in, and the suite directory underneath it -- and
// while they were independent literals, which assertion fired depended on which
// literal a spelling happened to match. That is not hypothetical: `cd
// <chart>/tests/` matched CHART_SUITE and tripped the exactly-once assertion,
// while `cd <chart>/tests` -- one character shorter, and the more natural way to
// write it -- matched neither, so the two spellings of one chdir got opposite
// verdicts and the safer-looking one was the one that passed. Deriving one from
// the other makes the two assertions visibly cover one path.
const CHART_DIR = "deploy/helm/paperclip";
const CHART_SUITE = `${CHART_DIR}/tests/`;

// `[a-z_]+` missed every job key containing a digit -- 3 of the 12 defined
// here (`opencode_k8s_seed_cold_start`, `vendor_claude_k8s`, `e2e`). Latent so
// far: a suite placed in `e2e` attributes to the preceding *matching* key
// (`canary_dry_run`) and still fails the owner assertion below, so it failed
// safe. It could only false-pass if a digit-named job were defined immediately
// after `helm_chart` (today `typecheck_release_registry`).
//
// Anchored past `jobs:` so that count stays checkable. Two-space keys also
// occur under `on:` -- `pull_request:` and `merge_group:` -- so an unanchored
// scan matches 14 keys while the comment says 12, and the next person to
// re-derive the number gets 14 and concludes the comment has drifted. Both sit
// above every job, so this was inert in the safe direction; the anchor buys
// honesty about the count rather than a behaviour change.
const JOBS_AT = workflow.indexOf("\njobs:\n");
assert.notEqual(JOBS_AT, -1, "pr.yml must declare a jobs: block");

function jobOwning(offset) {
  let owner = null;
  for (const match of workflow.matchAll(/\n {2}([a-z0-9_-]+):\n/g)) {
    if (match.index >= offset) break;
    if (match.index < JOBS_AT) continue;
    owner = match[1];
  }
  return owner;
}

function jobRegion(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `pr.yml must define ${name}`);
  const after = workflow.slice(start + 1);
  const nextJob = after.search(/\n {2}[a-z0-9_-]+:\n/);
  return nextJob === -1 ? after : after.slice(0, nextJob + 1);
}

test("the chart render suite runs in exactly one job, and that job is helm_chart", () => {
  const offsets = [];
  for (let at = workflow.indexOf(CHART_SUITE); at !== -1; at = workflow.indexOf(CHART_SUITE, at + 1)) {
    offsets.push(at);
  }
  assert.equal(
    offsets.length,
    1,
    `pr.yml must reference ${CHART_SUITE} exactly once outside comments, found ${offsets.length}`,
  );
  assert.equal(jobOwning(offsets[0]), "helm_chart", `${CHART_SUITE} must run in the helm_chart job`);
});

// The chdir escapes named above. Scoped to steps that ALSO run `node --test`:
// `helm lint`/`helm template` against the chart are legitimate anywhere (and
// docker.yml does exactly that, four times), so a bare chdir is not the thing
// being caught -- running the suite from inside the chart is.
//
// The directory is bounded by a delimiter class, not by end-of-line. An
// end-of-line anchor only catches a chdir that is the whole line, so
// `cd <dir> && node --test ...` -- the most idiomatic single-line spelling --
// walked straight through it, as did `;`, `||` and a trailing comment. The left
// side needs the same treatment for three separate reasons: a chdir can be the
// second half of a compound command (`mkdir -p x && cd <dir>`); on a
// single-line `run:` there is no newline in front of `cd` at all, so anchoring
// on one silently exempted the inline spelling while catching the identical
// `run: |` block form; and it can open a subshell or sit inside a quoted
// command -- `(cd <dir> && ...)`, `bash -c "cd <dir> && ..."`, `if cd <dir>;
// then ...` -- which is the idiomatic way to chdir without leaking the
// directory into everything after it.
//
// The left side admits command position, NOT bare whitespace. Requiring the
// literal token `cd`/`pushd`/`working-directory:` stops a word that merely ends
// in `cd`, but it does not stop `cd` appearing mid-sentence, and bare `\s` in
// front of it made the gate fire on the chart path merely NAMED in prose:
//
//     run: node --test ./x.test.mjs  # never cd <dir> here
//     run: |
//       echo "do not cd <dir>"
//
// Both are false reds, and this file's own premise (the comment-stripper at the
// top) is that a sentence about a rule must not count as an instance of
// breaking it -- most
// sharply here, since a step that runs `node --test` and explains why it must
// not chdir is exactly where that sentence belongs. Whole-line comments are
// already blanked, so the exposure was the two contexts the stripper
// deliberately leaves alone: a TRAILING comment (left alone so `"${#failed[@]}"`
// survives) and text inside a quoted string. Enumerating those two as escapes
// was the alternative; command position removes the class instead, and costs
// nothing -- every real spelling above still matches, via `(`, `["']` (the
// quote in `bash -c "cd ...` is adjacent to `cd`), or
// `\b(?:if|elif|then|else|do|while|until)` for the `if cd <dir>; then` form.
// `)` joins the right-hand class for `(cd <dir>)` with no trailing command
// inside the subshell.
//
// `{` and `!` are in the left-hand class, and the keyword list carries `elif`,
// `while` and `until`, because the first cut of that class -- bare `[\n;&|(]`
// with `if|then|else|do` -- dropped five command positions along with the
// whitespace it was narrowing away: `{ cd <chart> && ...; }`, `elif cd ...`,
// `while cd ...`, `until cd ...`, `! cd ... || ...`. The brace group is the one
// that matters: it is the same "chdir without leaking into everything after"
// idiom as the subshell this list already covers via `(`, minus the subshell,
// so covering one spelling and not its sibling was arbitrary. `elif` needs its
// own alternative rather than riding on `if`, because `\b` fails inside it --
// the preceding `l` is a word character. Re-admitting `{` and `!` does not
// reopen the prose class they were removed for: both false reds put a bare
// SPACE before `cd` (`# never cd <dir>`, `echo "do not cd <dir>"`), and neither
// `{` nor `!` is whitespace.
// `pushd` is in the alternation because it is `cd` with a
// stack: nothing here pushd's into the chart for any other purpose, so naming
// it as an escape and covering it cost the same, and only one of those two
// stays true as the file changes.
//
// Still not exhaustive, and deliberately not claimed to be -- but the escapes
// worth naming are the ones a reader would otherwise assume are closed, not the
// ones that are obviously out of reach. Two escape:
//
//   * A chdir whose path is built from a shell variable or a matrix value:
//     `cd $GITHUB_WORKSPACE/deploy/helm/paperclip`. Note the path IS there
//     literally -- the reason this escapes is narrower than "the path never
//     appears": the prefix admits only `.` or `/` in front of the directory, not
//     an arbitrary leading segment.
//   * A job-level `defaults: run: working-directory: <chart>` paired with a
//     plain `run: node --test ./tests/*.test.mjs`. Job defaults sit outside
//     every `- name:` chunk this loop inspects, so no step text contains the
//     chdir at all. Closing this needs the loop to read job-level keys, not a
//     wider regex.
//
// The directory itself is matched one segment deep rather than bounded at the
// chart root, because bounding it there let a chdir DEEPER than the chart walk
// through both assertions -- `cd <chart>/tests` being the obvious one.
//
// Both this and `policySteps` split steps on `- name: `, so a step written
// without a `name:` folds into the preceding step's chunk and is attributed to
// that step's offset. It fails safe the same way `jobOwning` does, and for the
// same reason: the text is still inside some chunk, and attribution can only
// drift backwards, never forwards into a job that has not started yet.

test("only helm_chart runs the chart suite from inside the chart directory (BLO-31516)", () => {
  const marker = "\n      - name: ";
  const offenders = [];
  for (let at = workflow.indexOf(marker); at !== -1; at = workflow.indexOf(marker, at + 1)) {
    const next = workflow.indexOf(marker, at + 1);
    const step = workflow.slice(at, next === -1 ? undefined : next);
    if (!step.includes("node --test")) continue;
    const chdirs = new RegExp(
      `(?:[\\n;&|({!]|run:|\\b(?:if|elif|then|else|do|while|until)[ \\t]|["'])[ \\t]*(?:working-directory:|cd|pushd) +["']?\\.?/?${CHART_DIR}(?:/[^\\s&;|"')]*)?(?=[\\s&;|"')]|$)`,
    ).test(step);
    if (chdirs && jobOwning(at) !== "helm_chart") {
      offenders.push(`${jobOwning(at)}: ${step.slice(marker.length).split("\n")[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `only helm_chart may run node --test from inside ${CHART_DIR}`);
});

// The exactly-once assertion matches the suite's path as TEXT, so it is only as
// strong as the guarantee that every invocation names its paths literally. All
// 40 `node --test` calls in pr.yml do -- there is not a single `**` in the file
// -- so that assertion can be trusted today, and nothing was holding it in
// place. Count that 40 against the comment-stripped source, the way this gate
// reads it: `grep -c` on the raw file gives 42, because two of the calls are
// prose in comments. Miscounting them as code is the exact confusion this file
// exists to remove, so it is worth not reproducing in its own margin.
//
// A glob wide enough to reach the suite without ever spelling its
// directory escapes the exactly-once assertion AND the chdir one above, while
// still running the tests. No chdir is involved, so neither escape named above
// covers it:
//
//     node --test ./deploy/helm/*/tests/*.test.mjs   <- one char from a caught spelling
//     node --test "./deploy/**/*.test.mjs"
//     node --test                                    <- default discovery, repo root
//
// The first is the one to weigh: a second chart under `deploy/helm/` makes it
// the natural way to write "all chart suites". Argless is the other: pr.yml has
// 40 near-identical single-file steps, so consolidating them is a plausible
// refactor, and default discovery from the repo root picks the suite up
// silently -- reintroducing exactly the duplicate this gate exists to catch.
//
// Gate the house style rather than chase spellings: every invocation names at
// least one path, and no path wildcards a DIRECTORY. That is a narrower claim
// than "the suite runs once" and it is what makes the text match above sound.
// A wildcard in the FILENAME is fine and stays fine -- `helm_chart`'s own
// `./deploy/helm/paperclip/tests/*.test.mjs` has one, and its `*` is followed
// by no `/`, which is precisely the distinction being drawn.
//
// Node's own value-taking flags, so a flag's VALUE is never mistaken for the
// positional path argument. Only space-separated forms are a hazard --
// `--flag=value` is one token and already reads as a flag. Short aliases are
// listed alongside their long spellings (`-r`/`--require`, `-C`/`--conditions`)
// because they are the same flag; `--import` and `--loader` have none.
//
// Listed explicitly rather than inferred from a shape, and the cost of a flag
// missing from the list runs in BOTH directions -- an earlier draft of this
// comment claimed it was only ever a missed row, which is wrong. An unconsumed
// value stays an operand, so:
//   - value has no glob -> it satisfies the rooted-path check itself, and the
//     step escapes. A missed row, the direction this file tolerates.
//   - value HAS a glob -> it also reaches the wildcard-directory scan below and
//     reports there, reddening a step that names a perfectly good rooted path.
//     A FALSE RED, the direction this file does not tolerate: a missed row is a
//     hole this gate is allowed to have, a false red fails an unrelated PR and
//     gets the assertion deleted.
// `--test-coverage-exclude`/`--test-coverage-include` are exactly that case --
// glob-valued by design, shipping since node 22, and the natural companions of
// `--experimental-test-coverage`, so wiring coverage into a `node --test` step
// is the ordinary edit that hits it rather than an exotic one. Both are listed
// for that reason; `--test-isolation` takes `process`/`none` and so only ever
// costs a missed row, and is listed for consistency. Worth re-checking against
// `node --help` whenever the pinned major moves -- and weighing any new
// value-taking flag by whether its value can hold a glob.
const VALUE_FLAGS =
  /^(?:--(?:test-(?:reporter|reporter-destination|name-pattern|skip-pattern|timeout|concurrency|shard|isolation|coverage-exclude|coverage-include)|import|require|loader|conditions)|-[rC])$/;
test("every node --test names explicit paths, so the text match above is sound (BLO-31516)", () => {
  const marker = "\n      - name: ";
  const offenders = [];
  for (let at = workflow.indexOf(marker); at !== -1; at = workflow.indexOf(marker, at + 1)) {
    const next = workflow.indexOf(marker, at + 1);
    const step = workflow.slice(at, next === -1 ? undefined : next);
    // `(?:[^\n\\]|\\\n)*` rather than `[^\n]*(?:\\\n[^\n]*)*`: a greedy
    // `[^\n]*` swallows the `\` that continues pr.yml's one multi-line
    // invocation, so the continuation branch never gets to match and that
    // step's two paths read as no paths at all -- a false red on the real file.
    for (const invocation of step.matchAll(/node --test((?:[^\n\\]|\\\n)*)/g)) {
      // A flag taking a SPACE-separated value leaves that value behind as a
      // bare token, which satisfies a non-flag check with the VALUE and
      // reopens the argless hazard one flag away -- node consumes the value and
      // then default-discovers, so from the repo root such a step picks the
      // chart suite up silently. Requiring the token look like a rooted path
      // narrowed that class but did not close it, because a flag value can be a
      // rooted path too. Verified on the pinned node 24, from a directory
      // containing `tests/a.test.mjs`, all three of these run it with no path
      // argument given: `--test-reporter ./my-reporter.mjs`,
      // `--test-reporter-destination ./coverage/out.tap`,
      // `--test-name-pattern a/b`. `--test-reporter-destination` is the
      // plausible one -- writing a TAP artifact for CI collection is exactly
      // why a step grows a reporter flag, and `--test-reporter` is required
      // alongside it. Consuming the value of a known value-taking flag is what
      // actually discriminates, so that is the check; the rooted-path filter
      // below is kept on top of it, narrower and for a different reason.
      const tokens = invocation[1].split(/[\s\\]+/).filter(Boolean);
      const operands = tokens
        .filter((arg, i) => !(tokens[i - 1] && VALUE_FLAGS.test(tokens[i - 1])))
        // `-` rather than `--`: a path never starts with a dash, and now that
        // short aliases are in VALUE_FLAGS a leftover `-r` would otherwise
        // count as an operand and report "no ROOTED path argument" on a step
        // that has no path argument at all -- the same misleading-message
        // defect the operands/args split above exists to fix.
        .filter((arg) => !arg.startsWith("-"));
      // Rooted, not merely non-flag. This is the house-style claim the rest of
      // this gate rests on -- all 40 invocations name a rooted path -- and it
      // is what keeps the exactly-once TEXT match sound. It is reported apart
      // from the argless case because they are different defects with different
      // fixes: `node --test a.test.mjs` HAS a path argument, so calling it
      // "no path argument" sends the next reader looking for the wrong thing.
      const args = operands.filter((arg) => arg.includes("/"));
      if (operands.length === 0) {
        offenders.push(`${jobOwning(at)}: node --test with no path argument`);
      } else if (args.length === 0) {
        offenders.push(`${jobOwning(at)}: node --test with no rooted path argument`);
      }
      // `{` alongside `**`: brace expansion wildcards a directory without ever
      // spelling `**`, and its `*` is not followed by `/`, so
      // `./deploy/helm/{paperclip,other}/tests/*.test.mjs` slipped past both
      // shapes -- the sibling spelling of the `deploy/helm/*/tests/` row above,
      // in exactly the "a second chart under deploy/helm/" scenario that makes
      // it the natural way to write "all chart suites".
      //
      // Variable expansions are stripped before that test, because `${VAR}` is
      // just the brace-delimited spelling of the bare `$VAR` form left alone
      // above, and the chdir preamble already names a shell-variable path as a
      // known-and-accepted escape. Testing the raw string accepted that form in
      // one assertion and rejected it in another, false-redding
      // `${GITHUB_WORKSPACE}/...`; `${{ github.workspace }}/...` survived only
      // because its `}}` leaves no bare `{` behind, which is luck, not intent.
      const literal = (path) => path.replace(/\$\{\{?[^}]*\}\}?/g, "");
      for (const arg of args.filter(
        (path) => path.includes("**") || literal(path).includes("{") || /\*[^\s]*\//.test(path),
      )) {
        offenders.push(`${jobOwning(at)}: wildcard directory in ${arg}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "every node --test must name explicit paths, without wildcarding a directory");
});

// BLO-29182 observed this exact invocation hang, and its fix bounded the copy
// that used to live in `policy`. Removing that copy has to carry the bound with
// it, or the one `node --test` step known to hang is unbounded again — a hung
// step would burn the whole job budget instead of failing attributably. The
// margin (4 min against a 73s p100) lives in the workflow comment; the
// invariant worth gating is only that a step bound exists and is under the cap.
test("the chart render step is bounded, and inside its job's budget (BLO-29182)", () => {
  const region = jobRegion("helm_chart");
  const jobCap = Number(region.match(/\n    timeout-minutes: (\d+)\n/)?.[1]);
  assert.ok(jobCap > 0, "helm_chart must declare a job-level timeout-minutes");
  const step = region
    .split("\n      - name: ")
    .slice(1)
    .find((candidate) => candidate.includes(CHART_SUITE));
  assert.ok(step, `helm_chart must contain the ${CHART_SUITE} step`);
  const stepBound = Number(step.match(/\n        timeout-minutes: (\d+)\n/)?.[1]);
  assert.ok(stepBound > 0, "the chart render step must declare a step-level timeout-minutes");
  assert.ok(stepBound < jobCap, `step bound ${stepBound}m must sit below the ${jobCap}m job cap`);
});

// BLO-31405 deleted the `policy` copy of this suite, and with it the only
// `azure/setup-helm` in pr.yml that pinned a version. The surviving install in
// `helm_chart` took `@v4` bare, so the render these tests gate floated on
// whatever helm the action resolved that morning: a release that changes
// template output would turn `verify` red repo-wide with no version to point
// at. `helm_chart`'s own preamble already leans on pinning ("the runner
// image's pinned yq"), so pin the chart renderer the same way and gate it.
//
// Read the `version:` key on its own rather than matching the shape of the
// whole `with:` block, and read only its value -- not the indent in front of
// it, the quotes around it, or what follows it on the line. The invariant is "a
// version is named and it isn't `latest`" -- the action's default -- and
// nothing more. Requiring `version` to be the first key under `with:`
// false-reds on a correctly pinned install the moment a sibling lands above it
// (`token` and `downloadBaseURL` are both real setup-helm inputs, and
// alphabetical ordering puts `downloadBaseURL` first); requiring a leading `v`
// and three components rejects `3.16.3` and `v3.17`, which the action documents
// as valid; and requiring a fixed ten-space indent with a bare value ending its
// line rejects `"v3.16.3"`, a twelve-space indent, `with: { version: ... }`,
// and a trailing comment on the pin line. That last one is the one to weigh:
// this pin already carries four comment lines justifying it, so moving any of
// that onto the pin line is the obvious next edit, and it would have turned
// `verify` red. Every one of these reported "must pin an explicit version"
// against an install that was pinned, which sends the next reader hunting for a
// pin that is right there.
//
// `[\s{,]` in front of the key is what keeps this off `node-version:`; the
// value ends at a quote, whitespace, `#`, `,` or `}`.
//
// The quote is captured rather than discarded for one narrow case in the other
// direction. YAML resolves an unquoted `\d+\.\d+` as a float, so `version: 3.10`
// reaches the action as `3.1` -- the `python-version: 3.10` trap. What survives
// that round trip wrong is a value whose fractional part ENDS in zero, and the
// zero-only case is the one to keep in mind: `3.0` and `4.0` reach the action as
// `3` and `4`, an unpinned major line, which is the same floating-render hazard
// this pin exists to close. `4.0` is the live one -- helm's 4.x line exists
// (v4.0.0 2025-11-12, v4.2.4 2026-08-13), so a bump to it is a plausible edit
// and `version: 4.0` is a natural way to write it. `3.16` is unaffected (it
// renders back as `3.16`), and either quoting the value or naming the patch
// component clears any of these.
test("the chart render job pins the helm it renders with (BLO-31516)", () => {
  const region = jobRegion("helm_chart");
  const step = region
    .split("\n      - name: ")
    .slice(1)
    .find((candidate) => candidate.includes("azure/setup-helm"));
  assert.ok(step, "helm_chart must install helm");
  const pin = step.match(/[\s{,]version:[ \t]*(["']?)([^"'\s#,}]+)\1/);
  const version = pin?.[2];
  assert.ok(
    version && version !== "latest",
    "the helm install must pin an explicit version, not float on the action's default (`latest`)",
  );
  assert.match(
    version,
    /^v?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?$/,
    `the helm version must name a release, got ${version}`,
  );
  assert.ok(
    pin[1] || !/^\d+\.\d*0+$/.test(version),
    `unquoted ${version} is a YAML float and reaches the action as ${Number(version)}; quote it or name the patch component`,
  );
});

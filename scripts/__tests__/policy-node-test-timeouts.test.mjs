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
// repo root -- individual files, a bare directory, a leading `./` -- including
// one inside a `run: |` block, which filtering to `run:` lines would miss
// (pr.yml has 17 such blocks). What it does NOT catch is a re-add that chdirs
// first, because then the path never appears in full. Both of these pass the
// assertion below; the one after it is what closes them.
//
//     run: |                              working-directory: deploy/helm/paperclip
//       cd deploy/helm/paperclip          run: node --test ./tests/*.test.mjs
//       node --test ./tests/*.test.mjs
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
function jobOwning(offset) {
  let owner = null;
  for (const match of workflow.matchAll(/\n {2}([a-z0-9_-]+):\n/g)) {
    if (match.index >= offset) break;
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
// side needs the same treatment for two separate reasons: a chdir can be the
// second half of a compound command (`mkdir -p x && cd <dir>`), and on a
// single-line `run:` there is no newline in front of `cd` at all, so anchoring
// on one silently exempted the inline spelling while catching the identical
// `run: |` block form. `pushd` is in the alternation because it is `cd` with a
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
      `(?:[\\n;&|]|run:)\\s*(?:working-directory:|cd|pushd) +["']?\\.?/?${CHART_DIR}(?:/[^\\s&;|"']*)?(?=[\\s&;|"']|$)`,
    ).test(step);
    if (chdirs && jobOwning(at) !== "helm_chart") {
      offenders.push(`${jobOwning(at)}: ${step.slice(marker.length).split("\n")[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `only helm_chart may run node --test from inside ${CHART_DIR}`);
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
// this pin exists to close. `4.0` is the live one -- helm v4 shipped
// 2026-08-13, so a bump to the 4.x line is a plausible edit and `version: 4.0`
// is a natural way to write it. `3.16` is unaffected (it renders back as
// `3.16`), and either quoting the value or naming the patch component clears
// any of these.
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

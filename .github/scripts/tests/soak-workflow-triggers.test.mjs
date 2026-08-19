import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const githubDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowsDir = path.join(githubDir, 'workflows');
const scriptsDir = path.join(githubDir, 'scripts');
const SOAK_WORKFLOW = 'soak-heartbeat-convergence.yml';
const SOAK_SCRIPT = 'soak-heartbeat-convergence.sh';

const soak = readFileSync(path.join(workflowsDir, SOAK_WORKFLOW), 'utf8');
const script = readFileSync(path.join(scriptsDir, SOAK_SCRIPT), 'utf8');

// The script's comments deliberately discuss the anti-patterns below by name
// (why `--repeat` is not equivalent, why bare `npx` is unsafe). Assertions that
// something is ABSENT have to run against executable lines only, or the
// explanation of the rule trips the rule.
const scriptCode = script
  // Join shell line-continuations FIRST. The `--repeat` assertion below is
  // deliberately scoped to a single line (see the comment there), so without
  // this a split invocation -- `pnpm exec vitest run "$TEST_FILE" \` with
  // `--repeat "$ITERATIONS"` on the next line -- would slip straight past it.
  .replace(/\\\n\s*/g, ' ')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

// BLO-28888 AC: the soak is ~50-90 minutes of self-hosted runner time. It is an
// on-demand job, and wiring it to any per-PR event would put that on the
// critical path of every pull request.
test('soak workflow is dispatch-only', () => {
  const triggers = soak
    .slice(soak.indexOf('\non:'), soak.indexOf('\npermissions:'))
    .split('\n')
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().replace(/:.*$/, ''));

  assert.deepEqual(triggers, ['workflow_dispatch']);
});

test('no other workflow or composite action invokes the soak', () => {
  // Both trees: a composite action under .github/actions/** referencing the
  // script would put the soak back on a per-PR path just as effectively as a
  // workflow would, and scanning only workflows/ would not see it.
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.(ya?ml|sh|mjs|js)$/.test(entry.name) ? [full] : [];
    });

  const offenders = [...walk(workflowsDir), ...walk(path.join(githubDir, 'actions'))]
    .filter((file) => path.basename(file) !== SOAK_WORKFLOW)
    .filter((file) => {
      const body = readFileSync(file, 'utf8');
      return body.includes(SOAK_WORKFLOW) || body.includes(SOAK_SCRIPT);
    })
    .map((file) => path.relative(githubDir, file));

  assert.deepEqual(offenders, []);
});

// The distinction this ticket turns on: `vitest --repeat N` repeats each test
// inside ONE process, which never re-exercises process startup or the embedded
// Postgres lifecycle. AC2 is about consecutive fresh runs.
//
// This has to assert against the SCRIPT, not just the workflow: the workflow
// only names the script, so a `--repeat` rewrite of the loop body would leave
// the workflow untouched and slip straight through a YAML-only guard.
test('soak runs the script rather than an inline --repeat', () => {
  assert.match(soak, new RegExp(`bash \\.github/scripts/${SOAK_SCRIPT}`));
  assert.doesNotMatch(soak, /--repeat/);
  // Scoped to an actual vitest argument rather than the bare string: the script
  // legitimately prints `process_model=...(not --repeat)` into summary.txt, and
  // a blanket check would forbid the artifact from naming the property it is
  // there to record. This still catches the mutation that matters -- rewriting
  // the loop body as `vitest run --repeat "$ITERATIONS" "$TEST_FILE"`.
  assert.doesNotMatch(scriptCode, /\bvitest\s+run\b[^\n]*--repeat/);
});

test('soak spawns exactly one fresh vitest process per iteration', () => {
  // Exactly one invocation in the whole script...
  const invocations = scriptCode.match(/vitest run/g) ?? [];
  assert.equal(
    invocations.length,
    1,
    'expected a single `vitest run` invocation in the soak script',
  );

  // ...and it must sit inside the per-iteration loop, so N iterations means N
  // processes. Hoisting it out of the loop (the `--repeat` shape by another
  // name) moves it outside this slice and fails here.
  const loopStart = scriptCode.indexOf('for i in $(seq 1 "$ITERATIONS")');
  assert.ok(loopStart > 0, 'expected a `for i in $(seq 1 "$ITERATIONS")` loop');
  const loopBody = scriptCode.slice(loopStart, scriptCode.indexOf('\ndone', loopStart));
  assert.match(loopBody, /vitest run "\$TEST_FILE"/);
});

test('soak resolves vitest from the local install, never the registry', () => {
  // Bare `npx` silently falls back to fetching vitest@latest when the install is
  // incomplete, which either stalls the soak on a registry blip or runs a
  // different major against this repo's vitest config. See BLO-28813.
  assert.doesNotMatch(scriptCode, /\bnpx\s+(?!--no-install\b)/);
  assert.match(scriptCode, /pnpm exec vitest run "\$TEST_FILE"/);
});

test('soak takes a caller-supplied ref and defaults to 20 iterations', () => {
  assert.match(soak, /^ {6}ref:$/m);
  assert.match(soak, /^ {6}iterations:$/m);
  assert.match(soak, /default: "20"/);
});

test('soak workflow serialises dispatches so load readings stay attributable', () => {
  // /proc/loadavg is host-wide and not namespaced. Two concurrent dispatches on
  // the same runner would each read the other's burners and both report the
  // regime as reached — a failure in the flattering direction.
  assert.match(soak, /^concurrency:$/m);
  assert.match(soak, /^ {2}group: soak-heartbeat-convergence$/m);
  assert.match(soak, /^ {2}cancel-in-progress: false$/m);
});

test('soak samples its load baseline after a settle window, not at script start', () => {
  // The workflow installs dependencies immediately before invoking this script,
  // and a monorepo install leaves the 1-minute load average elevated. A single
  // reading at script start captures that decaying install load as "baseline",
  // so every dload0 measures `burners - install_load` and the attribution
  // verdict blames a CFS quota that is not there. Pin the mechanism: the
  // baseline must come from the settling sampler, not a bare /proc/loadavg read.
  assert.match(scriptCode, /BASELINE_LOAD="\$\(sample_baseline_load\)"/);
  const sampler = scriptCode.slice(
    scriptCode.indexOf('sample_baseline_load() {'),
    scriptCode.indexOf('BASELINE_LOAD="$(sample_baseline_load)"'),
  );
  assert.ok(sampler.length > 0, 'expected a sample_baseline_load definition');
  assert.match(sampler, /LOAD_SETTLE_S/);

  // Every tunable that feeds a `sleep` is validated -- with no `set -e`,
  // `sleep abc` fails and the soak continues as a silently different experiment.
  for (const knob of ['LOAD_WARMUP_S', 'LOAD_SETTLE_S']) {
    assert.match(
      scriptCode,
      new RegExp(`\\[\\[ "\\$${knob}" =~ \\^\\[0-9\\]\\+\\$ \\]\\]`),
      `expected ${knob} to be validated as an integer before it reaches sleep`,
    );
  }
});

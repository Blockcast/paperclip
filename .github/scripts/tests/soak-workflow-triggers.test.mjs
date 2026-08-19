import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../workflows',
);
const SOAK_WORKFLOW = 'soak-heartbeat-convergence.yml';
const SOAK_SCRIPT = 'soak-heartbeat-convergence.sh';

const soak = readFileSync(path.join(workflowsDir, SOAK_WORKFLOW), 'utf8');

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

test('no other workflow invokes the soak', () => {
  const offenders = readdirSync(workflowsDir)
    .filter((file) => file !== SOAK_WORKFLOW && /\.ya?ml$/.test(file))
    .filter((file) => {
      const body = readFileSync(path.join(workflowsDir, file), 'utf8');
      return body.includes(SOAK_WORKFLOW) || body.includes(SOAK_SCRIPT);
    });

  assert.deepEqual(offenders, []);
});

// The distinction this ticket turns on: `vitest --repeat N` repeats each test
// inside ONE process, which never re-exercises process startup or the embedded
// Postgres lifecycle. AC2 is about consecutive fresh runs.
test('soak runs the script rather than an inline --repeat', () => {
  assert.match(soak, new RegExp(`bash \\.github/scripts/${SOAK_SCRIPT}`));
  assert.doesNotMatch(soak, /--repeat/);
});

test('soak takes a caller-supplied ref and defaults to 20 iterations', () => {
  assert.match(soak, /^ {6}ref:$/m);
  assert.match(soak, /^ {6}iterations:$/m);
  assert.match(soak, /default: "20"/);
});
